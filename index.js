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
            default: process.cwd()
        }
    })
    .example('$0 -o ./tpn', 'run the tool and output text and backing json to ${projectRoot}/tpn directory.')
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
    // first - check that this is even a bower project
    if (!jetpack.exists(path.join(options.baseDir, 'package.json'))) {
        console.log('this does not look like an NPM project, skipping NPM checks.');
        return [];
    }

    return bluebird.fromCallback((cb) => {
        return npmchecker.init({
            start: options.baseDir,
            production: true,
            customFormat: licenseCheckerCustomFormat
        }, cb);
    })
    .then((result) => {
        // we want to exclude the top-level project from being included
        var topLevelProjectInfo = jetpack.read(path.join(options.baseDir, 'package.json'), 'json');
        var keys = Object.getOwnPropertyNames(result).filter((k) => {
            return k !== `${topLevelProjectInfo.name}@${topLevelProjectInfo.version}`;
        });

        return bluebird.map(keys, (key) => {
            console.log('processing', key);
            var package = result[key];
            return jetpack.findAsync(path.join(options.baseDir, 'node_modules'), {
                matching: `**/${package.name}`,
                directories: true,
                files: false
            })
            .then((hits) => {
                var pathToExport = '';
                if (hits && hits.length && hits.length > 0) {
                    pathToExport = path.resolve(hits[0].trim());
                    if (jetpack.exists(pathToExport)) {
                        return pathToExport;
                    }
                }
                // probably a core module, take a guess at it's path
                var possiblePath = path.resolve(path.join(options.baseDir, 'node_modules', package.name));
                return jetpack.exists(possiblePath) ? possiblePath : resolution;
            })
            .then((packagePath) => {
                var packageJsonPath = path.join(packagePath, 'package.json');
                return jetpack.read(packageJsonPath, 'json');
            })
            .then((packageJson) => {
                console.log('processing', packageJson.name);

                var authors = packageJson.author && getAttributionForAuthor(packageJson.author)
                    || (packageJson.contributors && packageJson.contributors.map((c) => {
                        return getAttributionForAuthor(c);
                    }).join(', '))
                    || (packageJson.maintainers && packageJson.maintainers.map((m) => {
                        return getAttributionForAuthor(m);
                    }).join(', '));

                var licenseObject = {
                    ignore: false,
                    name: package.name,
                    version: package.version,
                    authors: authors,
                    url: package.repository,
                    license: package.licenses,
                    licenseText: ''
                };

                if (package.licenseFile && jetpack.exists(package.licenseFile)) {
                    licenseObject.licenseText = jetpack.read(package.licenseFile);
                }

                return licenseObject;
            });
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
    if (!jetpack.exists(path.join(options.baseDir, 'bower.json'))) {
        console.log('this does not look like a Bower project, skipping Bower checks.');
        return [];
    }

    bower.config.cwd = options.baseDir;
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
                return jetpack.readAsync(path.join(absPath, '.bower.json'), 'json')
                    .catch(() => {
                        return jetpack.readAsync(path.join(absPath, 'bower.json'), 'json');
                    })
                    .then((package) => {
                        console.log('processing', package.name);
                        // assumptions here based on https://github.com/bower/spec/blob/master/json.md
                        // extract necessary properties as described in TL;DR above
                        var url = package['_source']
                            || (package.repository && package.repository.url)
                            || package.url
                            || package.homepage;

                        var authors = '';
                        if (package.authors) {
                            authors = _.map(package.authors, (a) => {
                                return getAttributionForAuthor(a);
                            }).join(', ');
                        } else {
                            // extrapolate author from url if it's a git repository
                            var githubMatch = url.match(/github\.com\/.*\//);
                            if (githubMatch) {
                                authors = githubMatch[0].replace('github.com', '').replace(/\//g, '');
                            }
                        }

                        // normalize the license object
                        package.license = package.license || package.licenses;
                        var licenses = package.license && _.isString(package.license) ? package.license
                                : (_.isArray(package.license) ? package.license.join(',') : package.licenses);

                        // find the license file if it exists
                        var licensePath = _.find(component.children, (c) => {
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
    baseDir: path.resolve(yargs.argv.baseDir),
    outputDir: path.resolve(path.join(yargs.argv.baseDir, yargs.argv.outputDir))
};

bluebird.all([
    getNpmLicenses(),
    getBowerLicenses()
])
.catch((err) => {
    console.log(err)
})    
.spread((npmOutput, bowerOutput) => {
    var o = {};
    _.concat(npmOutput, bowerOutput).forEach((v) => {
        o[v.name] = v;
    });

    var userOverridesPath = path.join(options.outputDir, 'overrides.json');
    if (jetpack.exists(userOverridesPath)) {
        var userOverrides = jetpack.read(userOverridesPath, 'json');
        console.log('using overrides:', userOverrides);
        // foreach override, loop through the properties and assign them to the base object.
        _.each(Object.getOwnPropertyNames(userOverrides), (objKey) => {
            _.each(Object.getOwnPropertyNames(userOverrides[objKey]), (objPropKey) => {
                console.log('overriding', [objKey, objPropKey].join('.'), 'with', userOverrides[objKey][objPropKey]);
                o[objKey][objPropKey] = userOverrides[objKey][objPropKey];
            });
        });
    }
    
    return o;
})
.then((licenseInfo) => {
    var attribution = Object.getOwnPropertyNames(licenseInfo)
        .filter((key) => {
            console.log(key, 'ignore:', licenseInfo[key].ignore);
            return _.isPlainObject(licenseInfo[key]) && !licenseInfo[key].ignore;
        })
        .map((key) => {
            return `${licenseInfo[key].name}${os.EOL}${licenseInfo[key].version} <${licenseInfo[key].url}>${os.EOL}`
                + (licenseInfo[key].licenseText
                    || `license: ${licenseInfo[key].license}${os.EOL}authors: ${licenseInfo[key].authors}`);
        }).join(`${os.EOL}${os.EOL}******************************${os.EOL}${os.EOL}`);
    
    var headerPath = path.join(options.outputDir, 'header.txt');
    if (jetpack.exists(headerPath)) {
        var template = jetpack.read(headerPath);
        console.log('using template', template);
        attribution = template + os.EOL + os.EOL + attribution;
    }

    return jetpack.write(path.join(options.outputDir, 'attribution.txt'), attribution);
})
.then(() => {
    console.log('done');
    process.exit();
})
.finally(() => {
    process.exit(1);
});