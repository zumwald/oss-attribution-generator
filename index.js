#!/usr/bin/env node

// usage
var yargs = require('yargs')
    .usage('Calculate the npm modules used in this project and generate a third-party attribution (credits) text.',
    {
        outputDir: {
            alias: 'o',
            default: './oss-attribution'
        },
        baseDir: {
            alias: 'b',
            default: process.cwd(),
        }
    })
    .array('baseDir')
    .example('$0 -o ./tpn', 'run the tool and output text and backing json to ${projectRoot}/tpn directory.')
    .example('$0 -b ./some/path/to/projectDir', 'run the tool for Bower/NPM projects in another directory.')
    .example('$0 -o tpn -b ./some/path/to/projectDir', 'run the tool in some other directory and dump the output in a directory called "tpn" there.');

if (yargs.argv.help) {
    yargs.showHelp();
    process.exit(1);
}

// dependencies
var npmChecker = require('license-checker');
var path = require('path');
var jetpack = require('fs-jetpack');
var cp = require('child_process');
var os = require('os');
var taim = require('taim');
var sortBy = require('lodash.sortby');
var {promisify} = require('util');

var npmCheckerInit = promisify(npmChecker.init);

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
    return typeof a === 'string' ? a : a.name + ((a.email || a.homepage || a.url) ? ` <${a.email || a.homepage || a.url}>` : '');
}

async function getNpmLicenses() {
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
        var dir = npmDirs[i];
        const checker = await npmCheckerInit({
            start: npmDirs[i],
            production: true,
            customFormat: licenseCheckerCustomFormat
        });
        Object.getOwnPropertyNames(checker).forEach(k => {
            checker[k]['dir'] = dir;
        })
        checkers.push(checker);
    }
    if (checkers.length === 0) {
        return [];
    }

    return Promise.all(checkers)
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
            const finalResult = [];

            const promises = keys.map((key) => {
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
            return Promise.all(promises);
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


taim('Total Processing', 
    taim('Npm Licenses', getNpmLicenses()),
)
    .catch((err) => {
        console.log(err);
        process.exit(1);
    })
  .then((licenseInfos) => {
      var attributionSequence = sortBy(licenseInfos, licenseInfo => licenseInof.name.toLowerCase)
        .filter(licenseInfo => {
            return !licenseInfo.ignore && licenseInfo.name != undefined;
        })
        .map(licenseInfo => {
            return [licenseInfo.name,`${licenseInfo.version} <${licenseInfo.url}>`,
                    licenseInfo.licenseText || `license: ${licenseInfo.license}${os.EOL}authors: ${licenseInfo.authors}`].join(os.EOL);
        });

        var attribution = attributionSequence.join(`${os.EOL}${os.EOL}******************************${os.EOL}${os.EOL}`);

        var headerPath = path.join(options.outputDir, 'header.txt');
        
        if (jetpack.exists(headerPath)) {
            var template = jetpack.read(headerPath);
            console.log('using template', template);
            attribution = template + os.EOL + os.EOL + attribution;
        }

        jetpack.write(path.join(options.outputDir, 'licenseInfos.json'), JSON.stringify(licenseInfos));

        return jetpack.write(path.join(options.outputDir, 'attribution.txt'), attribution);
    })
    .catch(e => {
        console.error('ERROR writing attribution file', e);
        process.exit(1);
    })
    .then(() => {
        console.log('done');
        process.exit();
    });
