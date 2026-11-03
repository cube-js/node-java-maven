var assert = require('assert');
var crypto = require('crypto');
var fs = require('fs-extra');
var path = require('path');
var axios = require('axios').default;
var mvn = require('../index');
var REMOVE_M2_DIR_AFTER_EACH_TEST = true;

describe('maven', function() {
  var localRepository = path.join(__dirname, '.m2');
  console.log('local repo', localRepository);
  beforeEach(cleanUpM2Dir);
  afterEach(cleanUpM2Dir);
  testJson('com.j256.ormlite_ormlite-jdbc_4.48.json');
  testJson('org.apache.lucene_lucene-core_4.9.0.json');
  testJson('org.jboss.weld_weld-osgi-bundle_1.1.4.Final.json');
  testJson('com.amazonaws_aws-apigateway-importer_1.0.1.json');
  testJson('org.apache.pdfbox_pdfbox_1.8.10.json');
  testJson('org.springframework_spring_2.0.6.json');
  testJson('com.googlecode.netlib-java.netlib-java.json');

  it('should download jars byte-for-byte as published', function(done) {
    this.timeout(120 * 1000);
    var opts = {
      localRepository: localRepository,
      packageJsonPath: path.join(__dirname, 'com.j256.ormlite_ormlite-jdbc_4.48.json')
    };
    mvn(opts, function(err, mvnResults) {
      if (err) {
        return done(err);
      }
      assert.ok(mvnResults.classpath.length > 0, 'expected jars on the classpath');
      Promise.all(mvnResults.classpath.map(function(jarPath) {
        var relativePath = path.relative(localRepository, jarPath).split(path.sep).join('/');
        return axios.get('https://repo1.maven.org/maven2/' + relativePath + '.sha1', { responseType: 'text' })
          .then(function(res) {
            var expected = res.data.trim().split(/\s+/)[0];
            var actual = crypto.createHash('sha1').update(fs.readFileSync(jarPath)).digest('hex');
            assert.strictEqual(actual, expected, relativePath);
          });
      })).then(function() { done(); }, done);
    });
  });

  it('should report a missing artifact through the callback', function(done) {
    this.timeout(60 * 1000);
    var opts = {
      localRepository: localRepository,
      packageJsonPath: path.join(__dirname, 'missing-artifact.json')
    };
    mvn(opts, function(err) {
      // Resolution errors come back as an array, one entry per failed dependency.
      assert.ok(Array.isArray(err) && err.length === 1, 'expected one error for a missing artifact');
      assert.match(err[0].message, /download failed for .*missing-artifact.* \[status: 404\]/);
      done();
    });
  });

  function testJson(jsonPath) {
    it('should pull the maven dependencies for ' + jsonPath, function(done) {
      this.timeout(120 * 1000);
      var opts = {
        localRepository: localRepository, 
        packageJsonPath: path.join(__dirname, jsonPath)
      };
      mvn(opts, function(err, mvnResults) {
        if (err) {
          done(err);
          return console.error('could not resolve maven dependencies', err);
        }
        done();
      });
    });
  }
  
  function cleanUpM2Dir(done) {
    if (REMOVE_M2_DIR_AFTER_EACH_TEST) {
      fs.remove(localRepository, done);
    } else {
      done();
    }
  }
});
