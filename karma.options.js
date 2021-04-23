/*
 * Copyright (C) 2017-2020 HERE Europe B.V.
 * Licensed under Apache 2.0, see full license in LICENSE
 * SPDX-License-Identifier: Apache-2.0
 */

//@ts-check

const path = require("path");

/**
 * @type {import("karma").ConfigOptions}
 */
const options = function (isCoverage, isMapSdk, prefixDirectory) {
    const reports = isCoverage
        ? {
              "text-summary": "",
              // Needed for codecov.io, includes html as well
              lcov: "coverage"
          }
        : {};

    // Fixes the prefix to search for files, required for running the tests from sdk
    const fixPrefix = function (file) {
        if (typeof file === "string") {
            return path.join(prefixDirectory, file);
        } else {
            return {
                pattern: path.join(file.skip ? "" : prefixDirectory, file.pattern),
                included: file.included
            };
        }
    };

    return {
        frameworks: ["mocha", "karma-typescript"],

        // web server port
        port: 9876,

        // enable / disable watching file and executing tests whenever any file changes
        autoWatch: false,

        // Continuous Integration mode
        // if true, Karma captures browsers, runs the tests and exits
        singleRun: true,

        // Concurrency level
        // how many browser should be started simultaneous
        concurrency: Infinity,

        // List of files / patterns to load in the browser these files minus the ones specified
        // in the `exclude` property and where `included` isn't false. This dictates the code we
        // are to check its coverage. Note, the tests themselves don't count to code coverage and
        // are excluded using the karmaTypescriptConfig.coverage.exclude property.
        files: [
            "@here/harp-datasource-protocol/**/*.ts",
            "@here/harp-debug-datasource/**/*.ts",
            "@here/harp-geometry/**/*.ts",
            "@here/harp-fetch/**/*.ts",
            "@here/harp-utils/**/*.ts",
            "@here/harp-geoutils/**/*.ts",
            "@here/harp-mapview/**/*.ts",
            "@here/harp-mapview-decoder/**/*.ts",
            "@here/harp-materials/**/*.ts",
            "@here/harp-text-canvas/**/*.ts",
            "@here/harp-lrucache/**/*.ts",
            "@here/harp-transfer-manager/**/*.ts",
            "@here/harp-lines/**/*.ts",
            "@here/harp-test-utils/**/*.ts",
            "@here/harp-map-controls/**/*.ts",
            "@here/harp-olp-utils/**/*.ts",
            "@here/harp-webtile-datasource/**/*.ts",
            // Resources here are fetched by URL, note these require the correct proxy to be setup
            // see "proxies" below.
            {
                pattern: "@here/harp-test-utils/test/resources/*.*",
                included: false
            },
            // This is needed to access the font resources when running the repo separate from the
            // sdk.
            {
                pattern: "node_modules/@here/harp-fontcatalog/resources/**/*.*",
                skip: true,
                included: false
            },
            // This is needed when this repo is managed with the repo tool
            {
                pattern: "@here/harp-text-canvas/resources/fonts/**/*.*",
                included: false
            },
            {
                pattern: "@here/harp-mapview/test/resources/*.*",
                included: false
            },
            {
                pattern: "@here/harp-datasource-protocol/theme.schema.json",
                included: false
            },

            // This package doesn't work, specifically the reference to `vector_tile.js`, it needs
            // to be fixed, something like the following should work... but doesn't and needs to be
            // investigated.
            "@here/harp-vectortile-datasource/lib/adapters/omv/proto/vector_tile.js",
            "@here/harp-vectortile-datasource/**/*.ts",

            // This test complains about: Unable to resolve module [original-fs], it should be
            // checked if this test can run in the browser, or not.
            "@here/harp-map-theme/test/DefaultThemeTest.ts",
            // These files are needed for the test above.
            {
                pattern: "@here/harp-map-theme/resources/*.json",
                included: false
            }
        ].map(file => fixPrefix(file)),

        // Files that are to be excluded from the list included above.
        exclude: [
            "**/test/rendering/**/*.*",
            "@here/harp-test-utils/lib/rendering/RenderingTestResultServer.ts",
            "@here/harp-test-utils/lib/rendering/RenderingTestResultCli.ts",
            "@here/harp-datasource-protocol/test/ThemeTypingsTest.ts"
        ],

        // source files, that you wanna generate coverage for
        // do not include tests or libraries
        // (these files will be instrumented by Istanbul)
        preprocessors: {
            "@here/harp-vectortile-datasource/lib/adapters/omv/proto/vector_tile.js": [
                "karma-typescript"
            ],
            "@here/**/*.ts": ["karma-typescript"]
        },

        // karma-typescript generates a coverage folder
        reporters: ["progress", "karma-typescript"],
        proxies: {
            // How to access the local resources, normally this would handled by webpack, but we need to
            // bundle the tests with karma-typescript, so we have to configure where the resources are,
            // by default the resources relative to the root base folder.
            "/@here": "/base/@here",
            "/@here/harp-fontcatalog/resources/": isMapSdk
                ? "/base/@here/harp-text-canvas/resources/fonts/"
                : "/base/node_modules/@here/harp-fontcatalog/resources/"
        },
        karmaTypescriptConfig: {
            tsconfig: "./tsconfig.json",

            // Don't try to compile the referenced
            compilerOptions: {
                skipLibCheck: true,
                // This is needed because there is a Typescript file which references vector_tile.js
                allowJs: true
            },
            coverageOptions: {
                // This is needed otherwise the tests are included in the code coverage %.
                exclude: [/test/]
            },
            reports,
            // "allowJs" tries to compile all sorts of stuff, so we need to restrict it.
            exclude: ["**/webpack.*.js", "**/karma.*js"]
        }
    };
};
module.exports = { options };
