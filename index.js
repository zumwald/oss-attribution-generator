#!/usr/bin/env node

// usage
var yargs = require('yargs')
    .usage('Calculate the npm and bower modules used in this project and generate a third-party attribution (credits) text.',
    {
        outputDir: {
            alias: 'o',
            default: './oss-attribution'
        },
        baseDir: {
            alias: 'b',
            default: process.cwd(),
        },
        outputFormat: {
            alias: 'f',
            default: 'txt',
            choices: ['txt', 'html']
        }
    })
    .array('baseDir')
    .example('$0 -o ./tpn', 'run the tool and output text and backing json to ${projectRoot}/tpn directory.')
    .example('$0 -o ./tpn -f html', 'run the tool and output html and backing json to ${projectRoot}/tpn directory.')
    .example('$0 -b ./some/path/to/projectDir', 'run the tool for Bower/NPM projects in another directory.')
    .example('$0 -o tpn -b ./some/path/to/projectDir', 'run the tool in some other directory and dump the output in a directory called "tpn" there.');

if (yargs.argv.help) {
    yargs.showHelp();
    process.exit(1);
}

// dependencies
var bluebird = require('bluebird');
var _ = require('lodash');
var npmchecker = require('license-checker');
var bower = require('bower');
var path = require('path');
var jetpack = require('fs-jetpack');
var cp = require('child_process');
var os = require('os');
var taim = require('taim');

// const
var licenseCheckerCustomFormat = {
    name: '',
    version: '',
    description: '',
    repository: '',
    publisher: '',
    email: '',
    url: '',
    licenses: '',
    licenseFile: '',
    licenseModified: false
}

/**
 * Helpers
 */
function getAttributionForAuthor(a) {
    return _.isString(a) ? a : a.name + ((a.email || a.homepage || a.url) ? ` <${a.email || a.homepage || a.url}>` : '');
}

function getNpmLicenses() {
    var npmDirs;
    if (!Array.isArray(options.baseDir)) {
        npmDirs = [options.baseDir];
    } else {
        npmDirs = options.baseDir;
    }
    // first - check that this is even an NPM project
    for (var i = 0; i < npmDirs.length; i++) {
        if (!jetpack.exists(path.join(npmDirs[i], 'package.json'))) {
            console.log('directory at "' + npmDirs[i] + '" does not look like an NPM project, skipping NPM checks for path ' + npmDirs[i]);
            return [];
        }
    }
    console.log('Looking at directories: ' + npmDirs)

    var res = []
    var checkers = [];
    for (var i = 0; i < npmDirs.length; i++) {
        checkers.push(
            bluebird.fromCallback((cb) => {
                var dir = npmDirs[i];
                return npmchecker.init({
                    start: npmDirs[i],
                    production: true,
                    customFormat: licenseCheckerCustomFormat
                }, function (err, json) {
                    if (err) {
                        //Handle error
                        console.error(err);
                    } else {
                        Object.getOwnPropertyNames(json).forEach(k => {
                            json[k]['dir'] = dir;
                        })
                    }
                    cb(err, json);
                });
            })
        );
    }
    if (checkers.length === 0) {
        return [];
    }

    return bluebird.all(checkers)
        .then((raw_result) => {
            // the result is passed in as an array, one element per npmDir passed in
            // de-dupe the entries and merge it into a single object
            var merged = {};
            for (var i = 0; i < raw_result.length; i++) {
                merged = Object.assign(raw_result[i], merged);
            }
            return merged;
        }).then((result) => {
            
            // we want to exclude the top-level project from being included
            var dir = result[Object.keys(result)[0]]['dir'];
            var topLevelProjectInfo = jetpack.read(path.join(dir, 'package.json'), 'json');
            var keys = Object.getOwnPropertyNames(result).filter((k) => {
                return k !== `${topLevelProjectInfo.name}@${topLevelProjectInfo.version}`;
            });

            return bluebird.map(keys, (key) => {
                console.log('processing', key);

                var package = result[key];
                var defaultPackagePath = `${package['dir']}/node_modules/${package.name}/package.json`;
      
                var itemAtPath = jetpack.exists(defaultPackagePath);
                var packagePath = [defaultPackagePath];
      
                if (itemAtPath !== 'file') {
                  packagePath = jetpack.find(package['dir'], {
                    matching: `**/node_modules/${package.name}/package.json`
                  });
                }
      
                var packageJson = "";
      
                if (packagePath && packagePath[0]) {
                  packageJson = jetpack.read(packagePath[0], 'json');
                } else {

                  return Promise.reject(`${package.name}: unable to locate package.json`);
                }
      
                console.log('processing', packageJson.name, 'for authors and licenseText');
      
                var props = {};
      
                props.authors =
                  (packageJson.author && getAttributionForAuthor(packageJson.author)) ||
                  (packageJson.contributors && packageJson.contributors
                      .map(c => {

                        return getAttributionForAuthor(c);
                      }).join(', ')) ||
                  (packageJson.maintainers && packageJson.maintainers
                      .map(m => {

                        return getAttributionForAuthor(m);
                      }).join(', '));
      
                var licenseFile = package.licenseFile;
      
                try {
                  if (licenseFile && jetpack.exists(licenseFile) && path.basename(licenseFile).match(/license/i)) {
                    props.licenseText = jetpack.read(licenseFile);
                  } else {
                    props.licenseText = '';
                  }
                } catch (e) {
                  console.warn(e);

                  return {            
                    authors: '',
                    licenseText: ''
                  };
                }
      
                return {
                  ignore: false,
                  name: package.name,
                  version: package.version,
                  authors: props.authors,
                  url: package.repository,
                  license: package.licenses,
                  licenseText: props.licenseText
                };
            }, {
                concurrency: os.cpus().length
            });
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
            console.warn("Checking multiple directories is not yet supported for Bower projects.\n" +
                "Checking only the first directory: " + baseDir);
        }
    }
    if (!jetpack.exists(path.join(baseDir, 'bower.json'))) {
        console.log('this does not look like a Bower project, skipping Bower checks.');
        return [];
    }

    bower.config.cwd = baseDir;
    var bowerComponentsDir = path.join(bower.config.cwd, bower.config.directory);
    return jetpack.inspectTreeAsync(bowerComponentsDir, { relativePath: true })
        .then((result) => {
            /**
             * for each component, try to calculate the license from the NPM package info
             * if it is a available because license-checker more closely aligns with our
             * objective.
             */
            return bluebird.map(result.children, (component) => {
                var absPath = path.join(bowerComponentsDir, component.relativePath);
                // npm license check didn't work
                // try to get the license and package info from .bower.json first
                // because it has more metadata than the plain bower.json
      
                var package = '';
      
                try {
                  package = jetpack.read(path.join(absPath, '.bower.json'), 'json');
                } catch (e) {
                  package = jetpack.read(path.join(absPath, 'bower.json'), 'json');
                }
      
                console.log('processing', package.name);
                // assumptions here based on https://github.com/bower/spec/blob/master/json.md
                // extract necessary properties as described in TL;DR above
                var url = package["_source"] || (package.repository && package.repository.url) ||
                  package.url || package.homepage;
      
                var authors = '';

                if (package.authors) {
                  authors = _.map(package.authors, a => {
                    return getAttributionForAuthor(a);
                  }).join(', ');
                } else {
                  // extrapolate author from url if it's a github repository
                  var githubMatch = url.match(/github\.com\/.*\//);

                  if (githubMatch) {
                    authors = githubMatch[0]
                      .replace('github.com', '')
                      .replace(/\//g, '');
                  }
                }
      
                // normalize the license object
                package.license = package.license || package.licenses;

                var licenses = package.license && _.isString(package.license)
                    ? package.license
                    : _.isArray(package.license)
                      ? package.license.join(',')
                      : package.licenses;
      
                // find the license file if it exists
                var licensePath = _.find(component.children, c => {
                  return /licen[cs]e/i.test(c.name);
                });

                var licenseText = null;

                if (licensePath) {
                  licenseText = jetpack.read(path.join(bowerComponentsDir, licensePath.relativePath));
                }
      
                return {
                  ignore: false,
                  name: package.name,
                  version: package.version || package['_release'],
                  authors: authors,
                  url: url,
                  license: licenses,
                  licenseText: licenseText
                };
            }, {
                concurrency: os.cpus().length
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
    outputDir: path.resolve(yargs.argv.outputDir),
    outputFormat: ['txt', 'html'].includes(yargs.argv.outputFormat) ? yargs.argv.outputFormat : 'txt'
};

for (var i = 0; i < yargs.argv.baseDir.length; i++) {
    options.baseDir.push(path.resolve(yargs.argv.baseDir[i]));
}


taim('Total Processing', bluebird.all([
    taim('Npm Licenses', getNpmLicenses()),
    getBowerLicenses()
]))
    .catch((err) => {
        console.log(err);
        process.exit(1);
    })
    .spread((npmOutput, bowerOutput) => {
        var o = {};
        npmOutput = npmOutput || {};
        bowerOutput = bowerOutput || {};
        _.concat(npmOutput, bowerOutput).forEach((v) => {
            o[v.name] = v;
        });

        var userOverridesPath = path.join(options.outputDir, 'overrides.json');
        if (jetpack.exists(userOverridesPath)) {
            var userOverrides = jetpack.read(userOverridesPath, 'json');
            console.log('using overrides:', userOverrides);
            // foreach override, loop through the properties and assign them to the base object.
            o = _.defaultsDeep(userOverrides, o);
        }

        return o;
    })
    .catch(e => {
        console.error('ERROR processing overrides', e);
        process.exit(1);
    })
    .then((licenseInfos) => {
        var attributionSequence = _(licenseInfos).filter(licenseInfo => {
            return !licenseInfo.ignore && licenseInfo.name != undefined;
        }).sortBy(licenseInfo => {
            return licenseInfo.name.toLowerCase();
        }).map(licenseInfo => {
            if (options.outputFormat === 'html') {
                return `
                        <tr>
                            <td>${licenseInfo.name}</td>
                            <td>${licenseInfo.version}</td>
                            <td>${licenseInfo.url}</td>
                            <td>${licenseInfo.license}</td>
                            <td>${licenseInfo.licenseText}</td>
                        </tr>
                        `;
            }
            return [licenseInfo.name,`${licenseInfo.version} <${licenseInfo.url}>`,
                    licenseInfo.licenseText || `license: ${licenseInfo.license}${os.EOL}authors: ${licenseInfo.authors}`].join(os.EOL);
        }).value();
        
        if (options.outputFormat === 'html') {
            var tableHeader =
                `
                <tr>
                    <th>Name</th>
                    <th>Version</th>
                    <th>URL</th>
                    <th>License</th>
                    <th>LicenseText</th>
                </tr>
                `
            var attribution = `<table>${tableHeader}${attributionSequence.join("")}</table>`;
        } else {
            var attribution = attributionSequence.join(`${os.EOL}${os.EOL}******************************${os.EOL}${os.EOL}`);
        }

        var headerPath = path.join(options.outputDir, 'header.txt');
        
        if (jetpack.exists(headerPath)) {
            var template = jetpack.read(headerPath);
            console.log('using template', template);
            attribution = template + os.EOL + os.EOL + attribution;
        }

        jetpack.write(path.join(options.outputDir, 'licenseInfos.json'), JSON.stringify(licenseInfos));

        return jetpack.write(path.join(options.outputDir, `attribution.${options.outputFormat}`), attribution);
    })
    .catch(e => {
        console.error('ERROR writing attribution file', e);
        process.exit(1);
    })
    .then(() => {
        console.log('done');
        process.exit();
    });
