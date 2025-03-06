'use strict';

const fs = require('fs');
const async = require('async');
const xml2js = require('xml2js');
const request = require('request');
const path = require('path');
const { mkdirp } = require('mkdirp');
const Dependency = require('./lib/dependency');

module.exports = function(/*options, callback*/) {
  let options;
  let callback;
  if (arguments.length == 1) {
    options = {};
    callback = arguments[0];
  } else if (arguments.length == 2) {
    options = arguments[0];
    callback = arguments[1];
  } else {
    throw new Error('Expected 1 or 2 arguments not ' + arguments.length);
  }

  options = options || {};
  options.packageJsonPath = options.packageJsonPath || 'package.json';
  options.repositories = options.repositories || [
    {
      id: 'maven-central',
      url: 'https://repo1.maven.org/maven2/'
    }
  ];
  options.localRepository = options.localRepository || path.join(getUserHome(), '.m2/repository');
  options.concurrency = options.concurrency || 1;

  let dependencies = {};
  let exclusions = [];
  let errors = [];

  let dependencyQueue = async.queue(processDependency, options.concurrency);
  dependencyQueue.drain(complete);

  return go(callback);

  /***************************************************************************************/

  function go(callback) {
    return readPackageJson(function(err, packageJson) {
      if (err) {
        return callback(err);
      }

      if (packageJson.java.repositories) {
        options.repositories = options.repositories.concat(packageJson.java.repositories);
      }

      if (!packageJson.java.dependencies) {
        return callback(new Error("Could not find java.dependencies property in package.json"));
      }

      if (!(packageJson.java.dependencies instanceof Array)) {
        return callback(new Error("java.dependencies property in package.json must be an array."));
      }

      if (packageJson.java.exclusions) {
        if (!(packageJson.java.exclusions instanceof Array)) {
          return callback(new Error("java.exclusions property in package.json must be an array."));
        } else {
          exclusions = packageJson.java.exclusions;
        }
      }



      return packageJson.java.dependencies.forEach(function(d) {
        dependencyQueuePush(Dependency.createFromObject(d, 'package.json'));
      });
    });
  }

  function complete() {
    debug("COMPLETE");
    if (errors.length > 0) {
      return callback(errors);
    }
    const classpath = getClasspathFromDependencies(dependencies);
    return callback(null, {
      classpath: classpath,
      dependencies: dependencies
    });
  }

  function getUserHome() {
    return process.env.HOME || process.env.HOMEPATH || process.env.USERPROFILE;
  }

  function dependencyQueuePush(dependency, callback) {
    let dependencyArray = dependency;
    if (!(dependencyArray instanceof Array)) {
      dependencyArray = [dependency];
    }
    dependencyArray.forEach(function(d) {
      d.state = 'queued';

      if (!d.groupId) {
        throw new Error('missing required field [groupId] for queue: ' + d.toString());
      }
      if (!d.artifactId) {
        throw new Error('missing required field [artifactId] for queue: ' + d.toString());
      }
      if (!d.version) {
        throw new Error('missing required field [version] for queue: ' + d.toString());
      }
    });

    return dependencyQueue.push(dependency, callback);
  }

  function processDependency(dependency, callback) {
    return resolveDependency(dependency, function(err) {
      dependency.markCompleted();
      if (err) {
        errors.push(err);
      }
      const c = callback;
      callback = function() {};
      return c();
    });
  }

  function resolveDependency(dependency, callback) {
    let existingDependency = dependencies[dependency.toString()];
    if (existingDependency) {
      dependency.state = 'waitUntilComplete';
      return existingDependency.waitUntilComplete(callback);
    }

    debug('resolving: ' + dependency.toString());
    dependencies[dependency.toString()] = dependency;
    dependency.state = 'resolvePom';
    return resolvePom(dependency, function(err) {
      if (err) {
        return callback(err);
      }
      return processJar(dependency, callback);
    });

    function processJar(dependency, callback) {
      dependency.state = 'processJar';
      if (dependency.getPackaging() === 'jar' || dependency.getPackaging() === 'bundle') {
        return resolveJar(dependency, function(err) {
          if (err) {
            return callback(err);
          }
          return processParents(dependency, callback);
        });
      } else {
        return processParents(dependency, callback);
      }
    }

    function processParents(dependency, callback) {
      dependency.state = 'processParents';
      let parent = dependency.getParent();
      if (parent) {
        return processDependency(parent, function(err) {
          if (err) {
            return callback(err);
          }
          return processChildDependencies(dependency, callback);
        });
      } else {
        return processChildDependencies(dependency, callback);
      }
    }

    function processChildDependencies(dependency, callback) {
      dependency.state = 'processChildDependencies';
      let childDependencies = dependency
        .getDependencies()
        .filter(function(d) {
          let isExclusion = exclusions.reduce(function(isExclusion,exclusion){
            if (isExclusion){
              return isExclusion;
            }
            return exclusion.groupId === d.groupId && exclusion.artifactId === d.artifactId;
          },false );
          return d.scope !== 'test' && d.optional !== true  && !isExclusion;
        });
      if (childDependencies.length > 0) {
        childDependencies.forEach(function(d) {
          resolveDependencyUnknowns(d, dependency);
        });
        dependencyQueuePush(childDependencies);
      }
      return callback();
    }
  } // END resolveDependency

  function resolvePom(dependency, callback) {
    let pomPath = path.resolve(options.localRepository, dependency.getPomPath());
    return fs.exists(pomPath, function(exists) {
      if (exists) {
        return readFile(dependency, pomPath, callback);
      } else {
        return download(dependency, pomPath, callback);
      }
    });

    function download(dependency, pomPath, callback) {
      return downloadFile(dependency.getPomPath(), pomPath, dependency.reason, function(err, url) {
        if (err) {
          return callback(err);
        }
        dependency.pomUrl = url;
        return readFile(dependency, pomPath, callback);
      });
    }

    function readFile(dependency, pomPath, callback) {
      dependency.pomPath = pomPath;
      return fs.readFile(pomPath, 'utf8', function(err, data) {
        if (err) {
          return callback(err);
        }
        return loadFile(dependency, data, callback);
      });
    }

    function loadFile(dependency, data, callback) {
      xml2js.parseString(data, function(err, xml) {
        if (err) {
          return callback(err);
        }
        dependency.pomXml = xml;
        if (dependency.getParent()) {
          let parentDep = dependency.getParent();
          debug("resolving parent: " + parentDep);
          return resolvePom(parentDep, function(err, parentPomXml) {
            if (err) {
              return callback(err);
            }
            xml.project.parent[0].pomXml = parentPomXml;
            return callback(null, xml);
          });
        }
        return callback(null, xml);
      });
    }
  } // END resolvePom

  function resolveJar(dependency, callback) {
    let jarPath = path.resolve(options.localRepository, dependency.getJarPath());
    return fs.exists(jarPath, function(exists) {
      if (exists) {
        dependency.jarPath = jarPath;
        return callback();
      } else {
        return downloadFile(dependency.getJarPath(), jarPath, dependency.reason, function(err, url) {
          if (err) {
            return callback(err);
          }
          dependency.jarUrl = url;
          dependency.jarPath = jarPath;
          return callback();
        });
      }
    });
  }

  function readPackageJson(callback) {
    return fs.readFile(options.packageJsonPath, 'utf8', function(err, packageJsonString) {
      let packageJson
      if (err) {
        return callback(err);
      }
      try {
        packageJson = JSON.parse(packageJsonString);
      } catch (ex) {
        return callback(ex);
      }

      if (!packageJson.java) {
        return callback(new Error("Could not find java property in package.json"));
      }

      return callback(null, packageJson);
    });
  }

  function getClasspathFromDependencies(dependencies) {
    return Object.keys(dependencies)
      .map(function(depName) {
        return dependencies[depName].jarPath;
      })
      .filter(function(p) {
        return p;
      });
  }

  function resolveDependencyUnknowns(dependency, parent) {
    let p;

    if (dependency.groupId === '${project.groupId}') {
      dependency.groupId = parent.groupId;
    }

    if (!dependency.version) {
      let d = findInDependencyManagement(parent, dependency);
      if (d) {
        dependency.version = d.version;
      }
    }

    // this is a hack. should probably search the module list or something
    if (!dependency.version && dependency.groupId === parent.groupId) {
      dependency.version = parent.version;
    }

    if (!dependency.groupId || !dependency.artifactId || !dependency.version) {
      throw new Error('could not resolve unknowns: ' + dependency.toString());
    }

    if (dependency.groupId) {
      dependency.groupId = resolveSubstitutions(dependency.groupId, parent, dependency);
    }
    if (dependency.artifactId) {
      dependency.artifactId = resolveSubstitutions(dependency.artifactId, parent, dependency);
    }
    if (dependency.version) {
      let changed;
      do {
        let newValue = resolveSubstitutions(dependency.version, parent, dependency);
        changed = dependency.version != newValue;
        dependency.version = newValue;
      } while(changed);
    }
  }

  function resolveSubstitutions(str, pom, dependency) {
    str = str.replace(/\$\{(.*?)\}/g, function(m, propertyName) {
      if(propertyName === 'project.version' || propertyName === 'version') {
        return pom.version;
      }
      if(propertyName === 'project.parent.version') {
          return pom.pomXml.project.parent[0].version[0];
      }
      if(propertyName === 'project.parent.groupId') {
          return pom.pomXml.project.parent[0].groupId[0]
      }
      let property = resolveProperty(propertyName, pom);
      return property instanceof Array ? property.slice(-1) : property;
    });
    return resolveVersionRange(str, dependency);
  }

  function resolveVersionRange(str, dependency) {
    let m = str.match(/[\[\(](.*),(.*)[\]\)]/);
    if(m) {
      let existingDependency = findExistingDependencyWithoutVersion(dependency);
      if (existingDependency) {
        return existingDependency.version;
      }
      if(m[2]) {
        return m[2];
      } else if(m[1]) {
        return m[1];
      }
    }
    return str;
  }

  function findExistingDependencyWithoutVersion(dependency) {
    let matching = Object.keys(dependencies).filter(function(dependencyId) {
      let d = dependencies[dependencyId];
      return (d.groupId === dependency.groupId) && (d.artifactId === dependency.artifactId);
    });
    if (matching.length === 1) {
      return dependencies[matching[0]];
    }
    return null;
  }

  function resolveProperty(propertyName, pom) {
    if (pom.pomXml?.project) {
      let project = pom.pomXml.project;
      if (project.properties?.length === 1) {
        let properties = project.properties[0];
        if (properties[propertyName]) {
          return properties[propertyName];
        }
      }
      if (project.parent?.length === 1) {
        return resolveProperty(propertyName, project.parent[0]);
      }
    }
    throw new Error("Could not resolve property: " + propertyName);
  }

  function findInDependencyManagement(parent, dependency) {
    let list = parent
      .getDependencyManagementDependencies()
      .filter(function(d) {
        return (d.groupId === dependency.groupId) && (d.artifactId === dependency.artifactId);
      })

    list = list.filter(function(item, pos) {
      for(let i = 0; i < pos; i++) {
        if(list[i].toString() === item.toString()) {
          return false;
        }
      }
      return true;
    });

    if (list.length === 1) {
      let d = list[0];
      if (d.version === '${project.version}') {
        d.version = parent.version;
      }
      return d;
    } else if (list.length > 1) {
      throw new Error('multiple matches found in dependency management for ' + dependency.toString() + ' [' + list + ']');
    }

    let p = parent.getParent();
    if (p) {
      return findInDependencyManagement(dependencies[p.toString()], dependency);
    }
    return null;
  }

  function downloadFile(urlPath, destinationFile, reason, callback) {
    let repositoryIndex = 0;

    return mkdirp(path.dirname(destinationFile))
      .then(() => {
        let error = null;
        let foundUrl = null;
        return async.whilst(
          function (cb) {
            return cb(null, (repositoryIndex < options.repositories.length) && !foundUrl);
          },
          function (callback) {
            let repository = options.repositories[repositoryIndex];
            let url = repository.url + urlPath;
            let req_options = { url: url };
            if (repository.hasOwnProperty('credentials')) {
              let username = repository.credentials.username;
              let password = repository.credentials.password;
              req_options = {
                url: url,
                auth: {
                  user: username,
                  password: password
                }
              };
            }
            debug('downloading ' + url);
            let r = request(req_options);
            r.on('response', function (response) {
              if (response.statusCode !== 200) {
                error = new Error('download failed for ' + url + (reason ? ' (' + reason + ')' : '') + ' [status: ' + response.statusCode + ']');
                return callback();
              } else {
                let out = fs.createWriteStream(destinationFile);
                out.on('finish', function () {
                  foundUrl = url;
                  return callback();
                });
                out.on('error', function (err) {
                  return callback();
                });
                return r.pipe(out);
              }
            });
            repositoryIndex++;
          },
          function () {
            if (foundUrl) {
              return callback(null, foundUrl);
            }
            return callback(error);
          }
        );

      })
      .catch((err) => callback(err));
  }

  function debug() {
    if (options.debug) {
      console.log.apply(console, arguments);
    }
  }
};
