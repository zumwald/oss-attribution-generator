# oss-attribution-generator

utility to parse bower and npm packages used in a project and generate an attribution file to include in your product

[![code style: prettier](https://img.shields.io/badge/code_style-prettier-ff69b4.svg?style=flat-square)](https://github.com/prettier/prettier)

## Installation

`npm i -g oss-attribution-generator`

## Usage

### For a single Bower or Node project

```
cd pathToYourProject
generate-attribution
git add ./oss-attribution
git commit -m 'adding open source attribution output from oss-attribution-generator'
```

### For multiple projects

_(This feature is currently only supported for Node projects)_

For Node.js projects that use other Node.js projects located in different directories, the `-b` option can be used to provide a variable number of input directories. Each of the input directories are processed, and any duplicate entries (dependencies with same name and version number) are combined to produce a single attribution text.

```
cd pathToYourMainProject
generate-attribution -b pathToYourMainProject pathToYourFirstProjectDependency pathToYourSecondProjectDependency
git add ./oss-attribution
git commit -m 'adding open source attribution output from oss-attribution-generator'
```

### Help

Use the `--help` argument to get further usage details about the various program arguments:

```
generate-attribution --help
```

### Understanding the "overrides"

#### Ignoring a package

Sometimes, you may have an "internal" module which you/your team developed, or a module where you've arranged a special license with the owner. These wouldn't belong in your license attributions, so you can ignore them by creating an `overrides.json` file like so:

```
{
  "signaling-agent": {
      "ignore": true
  }
}
```

#### Changing the properties of package in the attribution file only

Other times, you may need to supply your own text for the purpose of the attribution/credits. You have full control of this in the `overrides.json` file as well:

```
{
  "some-package": {
    "name": "some-other-package-name",
    "version": "1.0.0-someotherversion",
    "authors": "some person",
    "url": "https://thatwebsite.com/since/their/original/link/was/broken",
    "license": "MIT",
    "licenseText": "you can even override the license text in case the original contents of the LICENSE file were wrong for some reason"
  }
}
```

## Prior art

Like most software, this component is built on the shoulders of giants; oss-attribution-generator was inspired in part by the following work:

* [license-checker](https://github.com/davglass/license-checker)
* [node-licensecheck](https://github.com/iceddev/node-licensecheck)
* [bower-license](https://github.com/AceMetrix/bower-license)
