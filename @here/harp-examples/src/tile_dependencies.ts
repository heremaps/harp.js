/*
 * Copyright (C) 2020-2021 HERE Europe B.V.
 * Licensed under Apache 2.0, see full license in LICENSE
 * SPDX-License-Identifier: Apache-2.0
 */

import { Theme } from "@here/harp-datasource-protocol";
import { DebugTileDataSource } from "@here/harp-debug-datasource";
import { TileKey, webMercatorTilingScheme } from "@here/harp-geoutils";
import { MapControls, MapControlsUI } from "@here/harp-map-controls";
import { CopyrightElementHandler, MapView, PickResult, Tile } from "@here/harp-mapview";
import {
    DataProvider,
    TileDataSource,
    TileDataSourceOptions,
    TileFactory
} from "@here/harp-mapview-decoder";
import { GUI } from "dat.gui";

import { CUSTOM_DECODER_SERVICE_TYPE } from "../decoder/custom_decoder_defs";

/**
 * This example shows how to use the {@link @here/harp-mapview#Tile.dependencies} property to ensure
 * that tiles which have geometry overlapping other.
 *
 * If you pan further enough left / right, you will see that the tile disappears.
 *
 * It combines part of the https://www.harp.gl/docs/master/examples/#object-picking.html and
 * https://www.harp.gl/docs/master/examples/#datasource_custom.html examples.
 * ```
 * {@link @here/harp-mapview#Tile}s that contain the geometry from another Tile need to have a
 * reference to the Tile containing the overlapping geometry, this is achieved using the
 * `dependencies` property of the {@link @here/harp-datasource-protocol#DecodedTile}
 * ```typescript
 * [[include:tile_dependencies.ts]]
 * ```
 **/

export namespace TileDependenciesExample {
    const guiOptions = { tileDependencies: false };
    document.body.innerHTML += `
        <style>
            #mouse-picked-result{
                position:absolute;
                bottom:5px;
                border-radius: 5px;
                margin-left:10px;
                padding: 9px 12px;
                background: #37afaa;
                display: inline-block;
                visibility: hidden;
                text-align: left;
                right:50px;
            }
            #mapCanvas {
              top: 0;
            }
        </style>
        <pre id="mouse-picked-result"></pre>
    `;
    class CustomDataProvider extends DataProvider {
        enableTileDependencies: boolean = false;

        constructor(readonly mainTileKey: TileKey) {
            super();
        }

        connect() {
            // Here you could connect to the service.
            return Promise.resolve();
        }

        ready() {
            // Return true if connect was successful.
            return true;
        }

        getTile(tileKey: TileKey, abortSignal?: AbortSignal): Promise<ArrayBufferLike | {}> {
            // Generate some artificial data. Normally you would do a fetch here.
            // In this example we create some geometry in geo space that will be converted to
            // local world space by [[CustomDecoder.convertToLocalWorldCoordinates]]

            const data = new Array<number>();
            // Do some scaling so that the data fits into the tile.
            const scale = 10.0 / (1 << tileKey.level);
            data.push(0.0, 0.0);
            for (let t = 0.0; t < Math.PI * 4; t += 0.1) {
                const x = Math.cos(t) * t * scale;
                const y = Math.sin(t) * t * scale * 10;
                data.push(x, y);
            }

            const { row, column, level } = tileKey;

            // The format of this is:
            // 1. row - which row number it is
            // 2. column - which column the tile is
            // 3. level - which level the row / column refer to
            // 4. number of x y values (i.e. double the number of points)
            // 5. list of x / y coordinates
            // 6. number of dependent tiles
            // 7. list of dependent tiles, note, we don't store morton codes, because these don't fit
            // into 32 bits
            // 8. row - the dependent row
            // 9. column - the dependent column
            // 10. level - the dependent level
            if (tileKey.mortonCode() === this.mainTileKey.mortonCode()) {
                return Promise.resolve(
                    new Float32Array([row, column, level, data.length, ...data, 0])
                );
            } else {
                // Simulate that the tile contents spread over multiple tiles
                if (
                    this.enableTileDependencies &&
                    (tileKey.column >= this.mainTileKey.column - 3 ||
                        tileKey.column <= this.mainTileKey.column + 3) &&
                    tileKey.row === this.mainTileKey.row
                ) {
                    //snippet:tile_dependencies.ts
                    const { row: mainRow, column: mainColumn, level: mainLevel } = this.mainTileKey;
                    return Promise.resolve(
                        new Float32Array([row, column, level, 0, 1, mainRow, mainColumn, mainLevel])
                    );
                    //end:tile_dependencies.ts
                }
            }
            return Promise.resolve({});
        }

        /** @override */ dispose() {
            // Nothing to be done here.
        }
    }

    // It is not mandatory to create a derived class to represent the tiles from the
    // CustomDataSource. It is just done here to show that it's possible.
    class CustomTile extends Tile {}

    class CustomDataSource extends TileDataSource<CustomTile> {
        constructor(options: TileDataSourceOptions) {
            super(new TileFactory<CustomTile>(CustomTile), options);
        }
    }

    // Create a custom theme that will be used to style the data from the CustomDataSource.
    function customTheme(): Theme {
        const theme: Theme = {
            // Create some lights for the "standard" technique.
            lights: [
                {
                    type: "ambient",
                    color: "#FFFFFF",
                    name: "ambientLight",
                    intensity: 0.9
                }
            ],
            styles: {
                // "customStyleSet" has to match the StyleSetName that is passed when creating
                // the CustomDataSource.
                // We distinguish different data by using the layer attribute that comes with the
                // data.
                customStyleSet: [
                    {
                        when: ["==", ["get", "layer"], "line-layer"],
                        technique: "solid-line",
                        attr: {
                            color: [
                                "case",
                                ["==", ["get", "id"], ["get", "selection", ["dynamic-properties"]]],
                                "#009900",
                                "#ffaa22"
                            ],
                            lineWidth: "10px",
                            clipping: false
                        }
                    }
                ]
            }
        };
        return theme;
    }

    function getCanvasPosition(
        event: MouseEvent | Touch,
        canvas: HTMLCanvasElement
    ): { x: number; y: number } {
        const { left, top } = canvas.getBoundingClientRect();
        return { x: event.clientX - Math.floor(left), y: event.clientY - Math.floor(top) };
    }

    let lastCanvasPosition: { x: number; y: number } | undefined;

    // Trigger picking event only if there's (almost) no dragging.
    function isPick(eventPosition: { x: number; y: number }) {
        const MAX_MOVE = 5;
        return (
            lastCanvasPosition &&
            Math.abs(lastCanvasPosition.x - eventPosition.x) <= MAX_MOVE &&
            Math.abs(lastCanvasPosition.y - eventPosition.y) <= MAX_MOVE
        );
    }

    const element = document.getElementById("mouse-picked-result") as HTMLPreElement;
    let current: PickResult | undefined;
    let currentPickedId: number = 0;

    function handlePick(mapViewUsed: MapView, x: number, y: number) {
        // get an array of intersection results from MapView

        let usableIntersections = mapViewUsed
            .intersectMapObjects(x, y)
            .filter(pr => (pr.intersection as any).object.userData.dataSource !== "background");
        if (usableIntersections.length > 1) {
            usableIntersections = usableIntersections.filter(item => item !== current);
        }

        if (usableIntersections.length === 0) {
            // Hide helper box
            element.style.visibility = "hidden";
            return;
        }

        // Get userData from the first result;
        current = usableIntersections[0];

        // Show helper box
        element.style.visibility = "visible";

        currentPickedId = current.userData.id as number;
        mapViewUsed.setDynamicProperty("selection", currentPickedId);
        // Display userData inside of helper box
        element.innerText = JSON.stringify(currentPickedId, undefined, 2);
    }

    // Create a new MapView for the HTMLCanvasElement of the given id.
    function initializeMapView(id: string): MapView {
        const canvas = document.getElementById(id) as HTMLCanvasElement;

        const map = new MapView({
            canvas,
            theme: customTheme()
        });

        CopyrightElementHandler.install("copyrightNotice", map);

        const mapControls = new MapControls(map);
        mapControls.tiltEnabled = false;

        map.lookAt({ target: [0, 0], zoomLevel: 16 });
        const ui = new MapControlsUI(mapControls);
        canvas.parentElement!.appendChild(ui.domElement);
        map.resize(window.innerWidth, window.innerHeight);

        window.addEventListener("resize", () => {
            map.resize(window.innerWidth, window.innerHeight);
        });

        const customDP1 = new CustomDataProvider(new TileKey(16385, 16384, 15));
        const customDP = new CustomDataProvider(new TileKey(16384, 16384, 15));

        // snippet:tile_dependencies_create.ts
        const customDatasource = new CustomDataSource({
            name: "customDatasource",
            styleSetName: "customStyleSet",
            tilingScheme: webMercatorTilingScheme,
            dataProvider: customDP,
            concurrentDecoderServiceName: CUSTOM_DECODER_SERVICE_TYPE,
            storageLevelOffset: -1
        });
        const customDatasource1 = new CustomDataSource({
            name: "customDatasource1",
            styleSetName: "customStyleSet",
            tilingScheme: webMercatorTilingScheme,
            dataProvider: customDP1,
            concurrentDecoderServiceName: CUSTOM_DECODER_SERVICE_TYPE,
            storageLevelOffset: -1
        });
        map.addDataSource(customDatasource1);
        map.addDataSource(customDatasource);

        // Also visualize the tile borders:
        const debugDataSource = new DebugTileDataSource(webMercatorTilingScheme, "debug", 20);
        map.addDataSource(debugDataSource);

        canvas.addEventListener("mouseup", event => {
            const canvasPos = getCanvasPosition(event, canvas);
            if (isPick(canvasPos)) {
                handlePick(map, canvasPos.x, canvasPos.y);
            }
        });

        canvas.addEventListener("mousedown", event => {
            lastCanvasPosition = getCanvasPosition(event, canvas);
        });

        const gui = new GUI({ width: 300 });
        gui.add(guiOptions, "tileDependencies").onChange(val => {
            customDP.enableTileDependencies = !customDP.enableTileDependencies;
            customDP1.enableTileDependencies = !customDP1.enableTileDependencies;
            map.clearTileCache();
            map.update();
        });
        map.setDynamicProperty("selection", 0);
        return map;
    }

    initializeMapView("mapCanvas");

    const instructions = `
Pan to the left / right until the tile in the center disappears.<br/>
To enable usage of the tile dependencies, check the checkbox,<br/>
the geometry will now always be visible.
Clicking on the geometry will show a box showing where you clicked.
If the tile dependencies checkbox is disabled, this will only work in
the center tile, because otherwise we assume that the contents of any
given tile remain in its boundaries.`;
    const message = document.createElement("div");
    message.style.position = "absolute";
    message.style.cssFloat = "right";
    message.style.top = "60px";
    message.style.right = "10px";
    message.style.backgroundColor = "grey";
    message.innerHTML = instructions;
    document.body.appendChild(message);
}
