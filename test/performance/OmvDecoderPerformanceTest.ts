/*
 * Copyright (C) 2019-2021 HERE Europe B.V.
 * Licensed under Apache 2.0, see full license in LICENSE
 * SPDX-License-Identifier: Apache-2.0
 */

import { Theme } from "@here/harp-datasource-protocol";
import { MapEnv, StyleSetEvaluator } from "@here/harp-datasource-protocol/index-decoder";
import { apikey } from "@here/harp-examples/config";
import {
    mercatorProjection,
    sphereProjection,
    TileKey,
    webMercatorProjection,
    webMercatorTilingScheme
} from "@here/harp-geoutils";
import { ThemeLoader } from "@here/harp-mapview";
import { getTestResourceUrl } from "@here/harp-test-utils/index.node";
import { measurePerformanceSync } from "@here/harp-test-utils/lib/ProfileHelper";
import {
    APIFormat,
    AuthenticationMethod,
    OmvRestClient,
    OmvRestClientParameters
} from "@here/harp-vectortile-datasource";
import { OmvDataAdapter } from "@here/harp-vectortile-datasource/lib/adapters/omv/OmvDataAdapter";
import { DecodeInfo } from "@here/harp-vectortile-datasource/lib/DecodeInfo";
import {
    IGeometryProcessor,
    ILineGeometry,
    IPolygonGeometry
} from "@here/harp-vectortile-datasource/lib/IGeometryProcessor";
import { VectorTileDataProcessor } from "@here/harp-vectortile-datasource/lib/VectorTileDecoder";
import { assert } from "chai";

if (typeof window === "undefined") {
    const perfHooks = require("perf_hooks");

    (global as any).performance = perfHooks.performance;
    (global as any).PerformanceObserver = perfHooks.PerformanceObserver;
    (global as any).PerformanceEntry = perfHooks.PerformanceEntry;
}

export interface OMVDecoderPerformanceTestOptions {
    /**
     *
     */
    repeats?: number;
    /**
     * Theme url or object.
     *
     * Will be resolved using [[ThemeLoader.load]].
     */
    theme: Theme | string;

    /**
     * Styleset name, defaults to `tilezen`.
     */
    styleSetName?: string;

    /**
     * Morton codes of tiles.
     */
    tiles: number[];

    /**
     * Requires settings for [[OmvRestClient]] to download tiles.
     */
    omvRestClientOptions: OmvRestClientParameters;
}

/**
 * Create tests that downloads some OMV tiles from real datasource, then decodes them using
 * particular style.
 *
 * @see OMVDecoderPerformanceTestOptions
 */
export function createOMVDecoderPerformanceTest(
    name: string,
    options: OMVDecoderPerformanceTestOptions
) {
    const repeats = options.repeats ?? 10;
    const styleSetName = options.styleSetName ?? "tilezen";
    describe(`OMVDecoderPerformanceTest - ${name}`, function () {
        this.timeout(0);
        let omvTiles: Array<[TileKey, ArrayBuffer]>;
        let theme: Theme;

        before(async function () {
            this.timeout(10000);
            const omvDataProvider = new OmvRestClient(options.omvRestClientOptions);

            await omvDataProvider.connect();
            assert(omvDataProvider.ready());
            omvTiles = await Promise.all(
                options.tiles.map(async mortonCode => {
                    const tileKey = TileKey.fromMortonCode(mortonCode);
                    const tile = await omvDataProvider.getTile(tileKey);
                    assert(tile instanceof ArrayBuffer);
                    return [tileKey, tile as ArrayBuffer] as [TileKey, ArrayBuffer];
                })
            );

            theme = await ThemeLoader.load(options.theme);
            assert.isObject(theme.styles);
            assert.isArray(theme.styles![styleSetName]);
        });

        it(`measure feature matching time`, async () => {
            const counterName = `OMVDecoderPerformanceTest-${name} styleMatchOnly`;
            this.timeout(0);

            const styleSetEvaluator = new StyleSetEvaluator({
                styleSet: theme.styles![styleSetName],
                definitions: theme.definitions
            });

            const geometryProcessor: IGeometryProcessor = {
                storageLevelOffset: 0,

                processPointFeature(
                    layerName: string,
                    layerExtents: number,
                    geometry: THREE.Vector3[],
                    env: MapEnv
                ) {
                    styleSetEvaluator.getMatchingTechniques(env, layerName, "point");
                },
                processLineFeature(
                    layerName: string,
                    layerExtents: number,
                    geometry: ILineGeometry[],
                    env: MapEnv
                ) {
                    styleSetEvaluator.getMatchingTechniques(env, layerName, "line");
                },

                processPolygonFeature(
                    layerName: string,
                    layerExtents: number,
                    geometry: IPolygonGeometry[],
                    env: MapEnv
                ) {
                    styleSetEvaluator.getMatchingTechniques(env, layerName, "polygon");
                }
            };

            await measurePerformanceSync(counterName, repeats, function () {
                for (const [tileKey, tileData] of omvTiles) {
                    const decoder = new OmvDataAdapter(geometryProcessor, undefined);
                    const decodeInfo = new DecodeInfo(
                        "profiler",
                        mercatorProjection,
                        tileKey,
                        webMercatorTilingScheme,
                        0
                    );
                    decoder.process(tileData, decodeInfo);
                }
            });
        });

        it(`measure decode time - webMercator`, async () => {
            const counterName = `OMVDecoderPerformanceTest-${name} webMercator`;
            this.timeout(0);

            const projection = webMercatorProjection;

            const styleSetEvaluator = new StyleSetEvaluator({
                styleSet: theme.styles![styleSetName],
                definitions: theme.definitions
            });

            await measurePerformanceSync(counterName, repeats, function () {
                for (const [tileKey, tileData] of omvTiles) {
                    const decoder = new VectorTileDataProcessor(
                        projection,
                        styleSetEvaluator,
                        false
                    );
                    decoder.getDecodedTile(tileKey, tileData);
                }
            });
        });

        it(`measure decode time - sphereProjection`, async () => {
            this.timeout(0);

            const counterName = `OMVDecoderPerformanceTest-${name} sphere`;

            const projection = sphereProjection;

            const styleSetEvaluator = new StyleSetEvaluator({
                styleSet: theme.styles![styleSetName],
                definitions: theme.definitions
            });

            await measurePerformanceSync(counterName, repeats, function () {
                for (const [tileKey, tileData] of omvTiles) {
                    const decoder = new VectorTileDataProcessor(
                        projection,
                        styleSetEvaluator,
                        false
                    );
                    decoder.getDecodedTile(tileKey, tileData);
                }
            });
        });
    });
}

const BERLIN_CENTER_TILES = [371506851, 371506850, 371506849, 371506848];

createOMVDecoderPerformanceTest("theme=berlin tiles=4 region=berlin data=herebase", {
    theme: getTestResourceUrl("@here/harp-map-theme", "resources/berlin_tilezen_base.json"),
    tiles: BERLIN_CENTER_TILES,
    omvRestClientOptions: {
        baseUrl: "https://vector.hereapi.com/v2/vectortiles/base/mc",
        apiFormat: APIFormat.XYZOMV,
        authenticationCode: apikey,
        authenticationMethod: {
            method: AuthenticationMethod.QueryString,
            name: "apikey"
        }
    }
});

createOMVDecoderPerformanceTest("theme=berlin tiles=4 region=berlin data=osmbase", {
    theme: getTestResourceUrl("@here/harp-map-theme", "resources/berlin_tilezen_base.json"),
    tiles: BERLIN_CENTER_TILES,
    omvRestClientOptions: {
        baseUrl: "https://vector.hereapi.com/v2/vectortiles/base/mc",
        apiFormat: APIFormat.XYZOMV,
        authenticationCode: apikey,
        authenticationMethod: {
            method: AuthenticationMethod.QueryString,
            name: "apikey"
        }
    }
});

const NEW_YORK_TILES = [
    327439127,
    327439124,
    327439125,
    327439168,
    327439170,

    327438781,
    327438783,
    327438826,
    327438782,
    327438824
];

createOMVDecoderPerformanceTest("theme=berlin tiles=10 region=ny data=herebase", {
    theme: getTestResourceUrl("@here/harp-map-theme", "resources/berlin_tilezen_base.json"),
    tiles: NEW_YORK_TILES,
    omvRestClientOptions: {
        baseUrl: "https://vector.hereapi.com/v2/vectortiles/base/mc",
        apiFormat: APIFormat.XYZOMV,
        authenticationCode: apikey,
        authenticationMethod: {
            method: AuthenticationMethod.QueryString,
            name: "apikey"
        }
    }
});

createOMVDecoderPerformanceTest("theme=berlin tiles=10 region=ny data=osmbase", {
    theme: getTestResourceUrl("@here/harp-map-theme", "resources/berlin_tilezen_base.json"),
    tiles: NEW_YORK_TILES,
    omvRestClientOptions: {
        baseUrl: "https://vector.hereapi.com/v2/vectortiles/base/mc",
        apiFormat: APIFormat.XYZOMV,
        authenticationCode: apikey,
        authenticationMethod: {
            method: AuthenticationMethod.QueryString,
            name: "apikey"
        }
    }
});
