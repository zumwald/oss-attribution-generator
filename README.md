# oss-attribution-generator
utility to parse bower and npm packages used in a project and generate an attribution file to include in your product

## Installation
`npm i -g oss-attribution-generator`

## Usage
```
cd pathToYourProject
generate-attribution
git add ./oss-attribution
git commit -m 'adding open source attribution output from oss-attribution-generator'
```

## Prior art
Like most software, this component is built on the shoulders of giants; oss-attribution-generator was inspired in part by the following work:
  - [license-checker](https://github.com/davglass/license-checker)
  - [node-licensecheck](https://github.com/iceddev/node-licensecheck)
  - [bower-license](https://github.com/AceMetrix/bower-license)