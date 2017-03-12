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
            .example('$0 -o ./tpn', 'run the tool and output text and backing json to ${projectRoot}/tpn directory')
            .example('$0 -b ./some/path/to/projectDir', 'run the tool for Bower/NPM projects in another directory. Note - the outputDir will still be relative to the directory generate-attribution is invoked from.')
            .example('$0 -o tpn -b ./some/path/to/projectDir', 'run the tool in some other directory and dump the output in a directory called "tpn" there.');

if (yargs.argv.help) {
    yargs.showHelp();
}

// dependencies
var bluebird = require('bluebird');
var _ = require('lodash');
var npmchecker = require('license-checker');
var bower = require('bower');
var path = require('path');
var jetpack = require('fs-jetpack');
var cp = require('child_process');

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
function getAttrubutionForAuthor(a){
    _.isString(a) ? a : (a.name + (a.email || a.homepage || a.url) ? ` <${a.email || a.homepage || a.url}>` : '');
}

function getNpmLicenses(){
    return bluebird.fromCallback((cb) => {
        return npmchecker.init({
            start: yargs.argv.baseDir,
            production: true,
            customFormat: licenseCheckerCustomFormat
        }, cb);
    })
    .then((result) => {
        // we want to exclude the top-level project from being included
        var topLevelProjectInfo = jetpack.read(path.join(yargs.argv.baseDir, 'package.json'), 'json');
        var keys = Object.getOwnPropertyNames(result).filter((k) => { 
            return k !== `${topLevelProjectInfo.name}@${topLevelProjectInfo.version}`; 
        });

        return bluebird.map(keys, (key) => {
            var package = result[key];
            return bluebird.try(() => {
                return cp.execSync(`node -e "console.log(require.resolve('${package.name}'))"`, { 
                    cwd: yargs.argv.baseDir,
                    encoding: 'utf8'
                })
                .then((resolution) => {
                    
                });
            })
            .then((packagePathExport) => {
                var nodeModulesPath = path.join(packagePathExport.slice(0, packagePathExport.lastIndexOf('node_modules')), 'node_modules');
                var packageJsonPath = path.join(nodeModulesPath, package.name, 'package.json');
                return jetpack.readAsync(packageJsonPath, 'json').finally((o) => {
                    console.log(packageJsonPath, o);
                    return o;
                });
            })
            .then((packageJson) => {
                var authors = packageJson.author && getAttrubutionForAuthor(packageJson.author) 
                        || packageJson.contributors.map((c) => {
                                return getAttrubutionForAuthor(c);
                            }).join(', ');
                
                var licenseObject = {
                    name: package.name,
                    version: package.version,
                    authors: authors,
                    url: package.repository,
                    license: package.licenses,
                    licenseText: ''
                };

                if (package.licenseFile){
                    return jetpack.readAsync(package.licenseFile)
                            .then((licenseText) => {
                                licenseObject.licenseText = licenseText;
                                return licenseObject;
                            });
                }else{
                    return licenseObject;
                }
            });
        });
    })
    .then((o) => {
            console.log('npm:', o);
            return o;
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
function getBowerLicenses(){
    bower.config.cwd = yargs.argv.baseDir;
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
                return bluebird.fromCallback((cb) => {
                    return npmchecker.init({
                        start: absPath,
                        production: true,
                        customFormat: licenseCheckerCustomFormat
                    }, cb);
                })
                .catch(() => {
                    // npm license check didn't work
                    // try to get the license and package info from .bower.json first
                    // because it has more metadata than the plain bower.json
                    return jetpack.readAsync(path.join(absPath, '.bower.json'), 'json')
                            .catch(() => { 
                                return jetpack.readAsync(path.join(absPath, 'bower.json'), 'json');
                            })
                    .then((package) => {
                        // assumptions here based on https://github.com/bower/spec/blob/master/json.md
                        // extract necessary properties as described in TL;DR above
                        var url = package['_source'] 
                                || (package.repository && package.repository.url) 
                                || package.url 
                                || package.homepage;

                        var authors = '';
                        if (package.authors){
                            authors = package.authors.map((a) => {
                                return getAttrubutionForAuthor(a);
                            }).join(', ');
                        }else{
                            // extrapolate author from url if it's a git repository
                            var githubMatch = url.match(/github\.com\/.*\//);
                            if (githubMatch){
                                authors = githubMatch[0].replace('github.com', '').replace(/\//g, '');
                            }
                        }
                        
                        // normalize the license object
                        package.license = package.license || package.licenses;
                        var licenses = _.isArray(package.license) ? package.license.join(',') : package.license;
                        
                        // find the license file if it exists
                        var licensePath = _.find(component.children, (c) => {
                            return /licen[cs]e/i.test(c.name);
                        });
                        var licenseText = '';
                        if (licensePath){
                            licenseText = jetpack.read(licensePath);
                        }

                        return {
                            name: package.name,
                            version: package.version,
                            authors: authors,
                            url: url,
                            license: licenses,
                            licenseText: licenseText
                        };
                    });
                });
            });
        })
        .then((o) => {
            console.log('bower:', o);
            return o;
        });
}

/**
 * MAIN
 */
bluebird.all([
    getNpmLicenses(),
    getBowerLicenses()
])
.spread((npmOutput, bowerOutput) => {
    console.log('npm:', npmOutput);
    console.log('bower:', bowerOutput);
})
.then(() => {
    process.exit();
})
.finally((err) => {
    console.error(err);
    process.exit(1);
});