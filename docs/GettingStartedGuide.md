# Getting Started Guide

To begin with `harp.gl`, we provide a few starting points:

-   [Import harp.gl with simple bundle](#simple)
-   [Create simple app](#npm) using npm
-   [Integrate `harp.gl` into your existing Webpack based project](#integrate)
-   [Integrate `harp.gl` into your existing Angular application](GettingStartedAngular.md)
-   [Look at examples](#examples)
-   [Don't forget the credentials](#credentials)

## <a name="simple"></a> Import harp.gl with simple bundle

Add `three.js` and `harp.gl` to your html and create a canvas with an id `map`:

```html
<html>
    <head>
        <style>
            body,
            html {
                border: 0;
                margin: 0;
                padding: 0;
            }
            #map {
                height: 100vh;
                width: 100vw;
            }
        </style>
        <script src="https://unpkg.com/three/build/three.min.js"></script>
        <script src="https://unpkg.com/@here/harp.gl/dist/harp.js"></script>
    </head>
    <body>
        <canvas id="map"></canvas>
        <script src="index.js"></script>
    </body>
</html>
```

Initialize the map:

```javascript
const map = new harp.MapView({
    canvas: document.getElementById("map"),
    theme:
        "https://unpkg.com/@here/harp-map-theme@latest/resources/berlin_tilezen_night_reduced.json",
    target: new harp.GeoCoordinates(37.773972, -122.431297), //San Francisco,
    zoomLevel: 13
});
const controls = new harp.MapControls(map);

window.onresize = () => map.resize(window.innerWidth, window.innerHeight);

const vectorDataSource = new harp.VectorTileDataSource({
    baseUrl: "https://vector.hereapi.com/v2/vectortiles/base/mc",
    authenticationCode: "YOUR-APIKEY"
});
map.addDataSource(vectorDataSource);
```

You need to [obtain an apikey](#credentials) to replace `YOUR-APIKEY` and use the service to download vector tiles.

For more information on the simple bundle, please visit the [@here/harp.gl module](../@here/harp.gl) directory.

For an in depth tutorial on getting started with harp.gl, please visit the [HERE Developer portal](https://developer.here.com/tutorials/harpgl/).

## <a name="npm"></a> Create Typescript app using `npm`

You can create simple `harp.gl` app using the package initializer [`@here/create-harp.gl-app`](https://github.com/heremaps/harp.gl/tree/master/%40here/create-harp.gl-app):

```shell
npm init @here/harp.gl-app
```

## <a name="integrate"></a> Integrate `harp.gl` into your existing Webpack based project

### Introduction

`harp.gl` is distributed as `CommonJS` modules conatined in `npm` packages. Modules in `CommonJS`
format require us to use some javascript code bundler - this example will faciliate `webpack`.

### Installation

Install them into your project:

```shell
npm install --save @here/harp-mapview @here/harp-vectortile-datasource @here/harp-map-theme
```

You have installed 3 key components needed to render basic map:

-   `@here/harp-mapview` - map renderer itself
-   `@here/harp-vectortile-datasource` - tile provider based on OMV/MVT vector tile format
-   `@here/harp-map-theme` - default theme and font resources required to render map in OMV/tilezen
    scheme

Since Three.js is a peer dependency of harp.gl it has to be installed as well. To get the version
that you should install you can use npm view.

```shell
THREE=`npm view @here/harp-mapview peerDependencies.three`
npm install --save three@$THREE
```

### Decoder bundle

Our example will decode OMV/MVT tiles in Web Workers, so we can achieve high performance because creating geometry from vector tiles is CPU intensive. For this, we need to create separate bundle with code that will run in Web Workers dedicated to
decoding.

Create a file named `./harp-gl-decoders.js` to initialize the decoding service:

```javascript
import { VectorTileDecoderService } from "@here/harp-vectortile-datasource/index-worker";

// Make sure the path is correct
self.importScripts("three.min.js");

VectorTileDecoderService.start();
```

Note, if you are using ESM modules, you will need to use async, like:

```javascript
self.importScripts("https://unpkg.com/three/build/three.min.js");

async function load() {
  const { VectorTileDecoderService } = await import(
    "@here/harp-vectortile-datasource/index-worker.js"
  );

  VectorTileDecoderService.start();
}

load();
```

### Create DOM container

`harp.gl` renders map on `HTML` `canvas` element. Add it to your HTML document:

```html
<!-- index.html -->
<canvas id="mapCanvas"></canvas>
<style>
    #mapCanvas {
        width: 500px;
        height: 300px;
        padding: 0;
        border: 0;
    }
</style>
```

### Webpack configuration

Install the webpack utilities into your project:

```shell
npm install --save-dev @here/harp-webpack-utils
```

Add the following lines to your `webpack.config.js`:

```javascript
const { addHarpWebpackConfig } = require("@here/harp-webpack-utils/scripts/HarpWebpackConfig");
const myConfig = {};
module.exports = addHarpWebpackConfig(myConfig, {
    mainEntry: "./index.js",
    decoderEntry: "./harp-gl-decoders.js",
    htmlTemplate: "./index.html"
});
```

`myConfig` is your existing Webpack configuration. Configuration values in `myConfig` will override any values generated by `addHarpWebpackConfig`.
`./index.js` is the path to your main application code. Will be used as the entry point for the main application bundle. May be omitted if Webpack `entry` configuration is included in `myConfig`.
`./harp-gl-decoders.js` is the path to your decoder service. Will be used as the entry point for the web worker decoder bundle. If omitted no decoder bundle will be created.
`./index.html` is the path to your HTML template index page. May be omitted if HTML configuration is included in `myConfig`.

### MapView

Then, you have to create [`MapView`](https://www.harp.gl/docs/master/doc/classes/_here_harp_mapview.mapview.html) that is will render map on `mapCanvas`:

```javascript
// index.js
import { MapView } from "@here/harp-mapview";

const mapCanvas = document.getElementById("mapCanvas");
const mapView = new MapView({
    canvas: mapCanvas,
    theme: "node_modules/@here/harp-map-theme/resources/berlin_tilezen_base.json",
    // note, this URL may vary depending on configuration of webpack
    // for this example, it is assumed that app is server from project root
    decoderUrl: "harp-gl-decoders.bundle.js"
    // note, this URL may vary depending on configuration of webpack
    // for this example, it is assumed that webpack emits bundles to project root
});
```

Next, you have to initialize default view settings like camera height over ground and location of
map center:

```javascript
// index.js
import { GeoCoordinates } from "@here/harp-geoutils";

// ...
mapView.camera.position.set(0, 0, 800);
mapView.geoCenter = new GeoCoordinates(40.70398928, -74.01319808, 0);
mapView.resize(mapCanvas.clientWidth, mapCanvas.clientHeight);
```

### Attach data source

Last step is adding some
[`VectorDataSource`](https://www.harp.gl/docs/master/doc/classes/harp_vectortile_datasource.vectortiledatasource-1.html)
to our `MapView` instance:

```javascript
import {
    APIFormat,
    AuthenticationTypeMapboxV4,
    VectorDataSource
} from "@here/harp-vectortile-datasource";

const dataSource = new VectorDataSource({
    baseUrl: "https://vector.hereapi.com/v2/vectortiles/base/mc",
    authenticationCode: "YOUR-APIKEY"
});
mapView.addDataSource(dataSource);
```

You need to [obtain an apikey](#credentials) to replace `YOUR-APIKEY` and use the service to download vector tiles.

### Enable user interaction with map

What we've achieved so far is basic, static non-interactive. If you want to enable control of map
like panning, rotating use
[`MapControls`](https://www.harp.gl/docs/master/doc/classes/_here_harp_map_controls.mapcontrols.html)

Note, this requires additional module: `npm install --save @here/harp-map-controls`.

```javascript
import { MapControls } from "@here/harp-map-controls";
MapControls.create(mapView);
```

## <a name="examples"></a> Examine examples

To begin with, we suggest taking a look at our most basic example, the equivalent of a `hello_world` in
the [examples package](../@here/harp-examples/README.md)

## <a name="credentials"></a> HERE Credentials

In order to use some of the HERE Services, you would need to register
and generate credentials.

First, you need to become a [HERE Developer](https://developer.here.com/).

Afterwards, please read the [Authentication and Authorization Guide](https://developer.here.com/documentation/authentication/dev_guide/index.html).

For [Map Tile API](https://developer.here.com/documentation/map-tile/dev_guide/topics/quick-start-map-tile.html), which is needed for the webtile examples, you need to generate an `apikey`.

For [Vector Tiles](https://developer.here.com/documentation/vector-tiles-api/dev_guide/index.html), you need to generate an `apikey`.

These credentials need to be passed to the Service in order to retrieve tiles, please see the
examples to check how it is done.
