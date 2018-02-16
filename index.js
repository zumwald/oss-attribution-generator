#!/usr/bin/env node

// usage
var yargs = require("yargs")
  .usage(
    "Calculate the npm and bower modules used in this project and generate a third-party attribution (credits) text.",
    {
      outputDir: {
        alias: "o",
        default: "./oss-attribution"
      },
      baseDir: {
        alias: "b",
        default: process.cwd()
      }
    }
  )
  .array("baseDir")
  .example(
    "$0 -o ./tpn",
    "run the tool and output text and backing json to ${projectRoot}/tpn directory."
  )
  .example(
    "$0 -b ./some/path/to/projectDir",
    "run the tool for Bower/NPM projects in another directory."
  )
  .example(
    "$0 -o tpn -b ./some/path/to/projectDir",
    'run the tool in some other directory and dump the output in a directory called "tpn" there.'
  );

if (yargs.argv.help) {
  yargs.showHelp();
  process.exit(1);
}

// dependencies
var bluebird = require("bluebird");
var _ = require("lodash");
var npmchecker = require("license-checker");
var bower = require("bower");
var path = require("path");
var jetpack = require("fs-jetpack");
var cp = require("child_process");
var os = require("os");
var taim = require('taim');

// const
var licenseCheckerCustomFormat = {
  name: "",
  version: "",
  description: "",
  repository: "",
  publisher: "",
  email: "",
  url: "",
  licenses: "",
  licenseFile: "",
  licenseModified: false
};

/**
 * Helpers
 */
function getAttributionForAuthor(a) {
  return _.isString(a) ? a : a.name + (a.email || a.homepage || a.url ? ` <${a.email || a.homepage || a.url}>` : "");
}

/**
 * get the base directories
 * @param {*} baseDir
 */
function getNpmDirs(baseDir) {
  if (!Array.isArray(options.baseDir)) {
    return [options.baseDir];
  } 
  return options.baseDir;
}

/**
 * callback handler
 * @param {*} fn
 */
function fromCallback(fn) {
  return new Promise((resolve, reject) => {
    let callbackHandler = (err, val) => {
      if (err) {
        reject(err);
      } else {
        resolve(val);
      }
    };
    fn(callbackHandler);
  });
}

/**
 * the result is passed in as an array, one element per npmDir passed
 * in de-dupe the entries and merge it into a single object
 * @param {*} raw_result
 */
function mergeRawResult(raw_result) {
  var merged = {};
  for (var i = 0; i < raw_result.length; i++) {
    merged = Object.assign(raw_result[i], merged);
  }
  return merged;
}

/**
 * exclude the top-level project from being included and get the keys from parsed Json
 * @param {*} result
 */
function getKeysFromResult(result) {
  var dir = result[Object.keys(result)[0]]["dir"];
  var topLevelProjectInfo = jetpack.readAsync(path.join(dir, "package.json"), "json");
  var keys = Object.getOwnPropertyNames(result).filter(k => {
    return k !== `${topLevelProjectInfo.name}@${topLevelProjectInfo.version}`;
  });
  return keys;
}
/**
 * read the package path and return as a json object
 * @param {*} packagePath
 * @param {*} package
 */
function getPackageJson(packagePath, package) {
  if (packagePath && packagePath[0]) {
    return jetpack.readAsync(packagePath[0], "json");
  } else {
    return Promise.reject(`${package.name}: unable to locate package.json`);
  }
}

/**
 * parse packageJson and build props object
 * @param {*} packageJson
 * @param {*} package
 */
function parsePackageJson(packageJson, package) {
 // console.log("processing", packageJson.name, "for authors and licenseText");
  var props = {};
  props.authors =
    (packageJson.author && getAttributionForAuthor(packageJson.author)) ||
    (packageJson.contributors && packageJson.contributors.map(c => {
        return getAttributionForAuthor(c);
    })
    .join(", ")) ||
    (packageJson.maintainers && packageJson.maintainers.map(m => {
        return getAttributionForAuthor(m);
    })
    .join(", "));

  props.licenseText = package.licenseFile && jetpack.exists(package.licenseFile) ? jetpack.readAsync(package.licenseFile) : "";
  return props;
}

/**
 * log error.
 * @param {*} e
 */
function logError(e) {
  console.warn(e);
  return {
    authors: "",
    licenseText: ""
  };
}

/**
 * return a custom object
 * @param {*} derivedProps
 * @param {*} package
 */
function customObject(derivedProps, package) {
  return {
    ignore: false,
    name: package.name,
    version: package.version,
    authors: derivedProps.authors,
    url: package.repository,
    license: package.licenses,
    licenseText: derivedProps.licenseText
  };
}


function getNpmLicenses() {
  var npmDirs = getNpmDirs(options.baseDir);

  // first - check that this is even an NPM project
  for (var i = 0; i < npmDirs.length; i++) {
    if (!jetpack.existsAsync(path.join(npmDirs[i], "package.json"))) {
      console.log(
        'directory at "' +
          npmDirs[i] +
          '" does not look like an NPM project, skipping NPM checks for path ' +
          npmDirs[i]
      );
      return [];
    }
  }
  console.log("Looking at directories: " + npmDirs);

  var res = [];
  var checkers = [];
  for (var i = 0; i < npmDirs.length; i++) {
    checkers.push(
      fromCallback(cb => {
        var dir = npmDirs[i];
        return npmchecker.init(
          {
            start: npmDirs[i],
            production: true,
            customFormat: licenseCheckerCustomFormat
          },
          function(err, json) {
            if (err) {
              //Handle error
              console.error(err);
            } else {
              Object.getOwnPropertyNames(json).forEach(k => {
                json[k]["dir"] = dir;
              });
            }
            cb(err, json);
          }
        );
      })
    );
  }
  if (checkers.length === 0) {
    return [];
  }

  return Promise.all(checkers)
    .then(taim('Merging Results:', raw_result => mergeRawResult(raw_result)))
    .then(result => {
      var keys = getKeysFromResult(result);
      
      var npmPromises = Promise.all(keys.map(key => {
        // console.log("processing", key);
        var package = result[key];
        console.log(package["dir"])
        return taim(`Processing ${key}`, jetpack.findAsync(package["dir"], {
            matching: `**/node_modules/${package.name}/package.json`
        }))
        .then(taim('Get PackageJson:', packagePath => getPackageJson(packagePath, package)))
        .then(taim('Get Properties:', packageJson => parsePackageJson(packageJson, package)))
        .catch(e => logError(e))
        .then(taim('Build Custom Object:', derivedProps => customObject(derivedProps, package)));
      }));
      
      taim('Npm Licenses Processing:', npmPromises);
      return npmPromises;
    });
}

/**
 * TL;DR - normalizing the output format for NPM & Bower license info
 *
 * The output from license-checker gives us what we need:
 *  - component name
 *  - version
 *  - authors (note: not returned by license-checker, we have to apply our heuristic)
 *  - url
 *  - license(s)
 *  - license contents OR license snippet (in case of license embedded in markdown)
 *
 * Where we calculate the license information manually for Bower components,
 * we'll return an object with these properties.
 */
function getBowerLicenses() {
  // first - check that this is even a bower project
  var baseDir;
  if (Array.isArray(options.baseDir)) {
    baseDir = options.baseDir[0];
    if (options.baseDir.length > 1) {
      console.warn(
        "Checking multiple directories is not yet supported for Bower projects.\n" +
          "Checking only the first directory: " +
          baseDir
      );
    }
  }
  if (!jetpack.exists(path.join(baseDir, "bower.json"))) {
    console.log(
      "this does not look like a Bower project, skipping Bower checks."
    );
    return [];
  }

  bower.config.cwd = baseDir;
  var bowerComponentsDir = path.join(bower.config.cwd, bower.config.directory);
  return jetpack
    .inspectTreeAsync(bowerComponentsDir, { relativePath: true })
    .then(result => {
      /**
       * for each component, try to calculate the license from the NPM package info
       * if it is a available because license-checker more closely aligns with our
       * objective.
       */
      return bluebird.map(result.children, component => {
        var absPath = path.join(bowerComponentsDir, component.relativePath);
        // npm license check didn't work
        // try to get the license and package info from .bower.json first
        // because it has more metadata than the plain bower.json
        return jetpack
          .readAsync(path.join(absPath, ".bower.json"), "json")
          .catch(() => {
            return jetpack.readAsync(path.join(absPath, "bower.json"), "json");
          })
          .then(package => {
            console.log("processing", package.name);
            // assumptions here based on https://github.com/bower/spec/blob/master/json.md
            // extract necessary properties as described in TL;DR above
            var url = package["_source"] || (package.repository && package.repository.url) || package.url || package.homepage;

            var authors = "";
            if (package.authors) {
              authors = _.map(package.authors, a => {
                return getAttributionForAuthor(a);
              }).join(", ");
            } else {
              // extrapolate author from url if it's a github repository
              var githubMatch = url.match(/github\.com\/.*\//);
              if (githubMatch) {
                authors = githubMatch[0]
                  .replace("github.com", "")
                  .replace(/\//g, "");
              }
            }

            // normalize the license object
            package.license = package.license || package.licenses;
            var licenses = package.license && _.isString(package.license) ? package.license : _.isArray(package.license) ? package.license.join(",") : package.licenses;

            // find the license file if it exists
            var licensePath = _.find(component.children, c => {
              return /licen[cs]e/i.test(c.name);
            });
            var licenseText = null;
            if (licensePath) {
              licenseText = jetpack.readAsync(path.join(bowerComponentsDir, licensePath.relativePath));
            }

            return { ignore: false, name: package.name, version: package.version || package["_release"], authors: authors, url: url, license: licenses, licenseText: licenseText };
          });
      });
    });
}

/***********************
 *
 * MAIN
 *
 ***********************/

// sanitize inputs
var options = {
  baseDir: [],
  outputDir: path.resolve(yargs.argv.outputDir)
};

for (var i = 0; i < yargs.argv.baseDir.length; i++) {
  options.baseDir.push(path.resolve(yargs.argv.baseDir[i]));
}

taim("Get Licenses", Promise.all([getNpmLicenses(), getBowerLicenses()]))
  .catch(err => {
    console.log(err);
    process.exit(1);
  })
  .then(taim('Concat Output:', (npmOutput, bowerOutput) => {
    var o = {};
    npmOutput = npmOutput || {};
    bowerOutput = bowerOutput || {};
    _.concat(npmOutput, bowerOutput).forEach(v => {
      o[v.name] = v;
    });

    var userOverridesPath = path.join(options.outputDir, "overrides.json");
    if (jetpack.exists(userOverridesPath)) {
      var userOverrides = jetpack.read(userOverridesPath, "json");
      console.log("using overrides:", userOverrides);
      // foreach override, loop through the properties and assign them to the base object.
      o = _.defaultsDeep(userOverrides, o);
    }

    return o;
  }))
  .catch(e => {
    console.error("ERROR processing overrides", e);
    process.exit(1);
  })
  .then(taim('Writing Output Files:', licenseInfos => {
    var attribution = _.filter(licenseInfos, licenseInfo => {
      return !licenseInfo.ignore;
    })
      .map(licenseInfo => {
        return [
          licenseInfo.name,
          `${licenseInfo.version} <${licenseInfo.url}>`,
          licenseInfo.licenseText ||
            `license: ${licenseInfo.license}${os.EOL}authors: ${
              licenseInfo.authors
            }`
        ].join(os.EOL);
      })
      .join(
        `${os.EOL}${os.EOL}******************************${os.EOL}${os.EOL}`
      );

    var headerPath = path.join(options.outputDir, "header.txt");
    if (jetpack.exists(headerPath)) {
      var template = jetpack.read(headerPath);
      console.log("using template", template);
      attribution = template + os.EOL + os.EOL + attribution;
    }

    jetpack.writeAsync(
      path.join(options.outputDir, "licenseInfos.json"),
      JSON.stringify(licenseInfos)
    );

    return jetpack.writeAsync(
      path.join(options.outputDir, "attribution.txt"),
      attribution
    );
  }))
  .catch(e => {
    console.error("ERROR writing attribution file", e);
    process.exit(1);
  })
  .then(() => {
    console.log("done");
    process.exit();
  });
