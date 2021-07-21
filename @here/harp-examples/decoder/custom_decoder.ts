/*
 * Copyright (C) 2019-2021 HERE Europe B.V.
 * Licensed under Apache 2.0, see full license in LICENSE
 * SPDX-License-Identifier: Apache-2.0
 */

import {
    DecodedTile,
    Geometry,
    GeometryType,
    InterleavedBufferAttribute
} from "@here/harp-datasource-protocol";
import {
    MapEnv,
    StyleSetEvaluator,
    ThreeBufferUtils
} from "@here/harp-datasource-protocol/index-decoder";
import { GeoCoordinates, Projection, TileKey, webMercatorTilingScheme } from "@here/harp-geoutils";
import { LineGroup } from "@here/harp-lines";
import {
    ThemedTileDecoder,
    TileDecoderService,
    WorkerServiceManager
} from "@here/harp-mapview-decoder/index-worker";
import { BoxBufferGeometry, Matrix4, Vector3 } from "three";

import { CUSTOM_DECODER_SERVICE_TYPE } from "./custom_decoder_defs";

// Height of line geometry in this sample.
const MIN_GEOMETRY_HEIGHT = -100;

export // snippet:custom_datasource_example_custom_decoder.ts
class CustomDecoder extends ThemedTileDecoder {
    // end:custom_datasource_example_custom_decoder.ts
    /** @override */
    connect() {
        return Promise.resolve();
    }

    /** @override */
    decodeThemedTile(
        data: ArrayBufferLike | {},
        tileKey: TileKey,
        styleSetEvaluator: StyleSetEvaluator,
        projection: Projection
    ): Promise<DecodedTile> {
        const geometries: Geometry[] = [];

        const array = new Float32Array(data as ArrayBuffer);
        const lineHeightRange = this.processLineFeatures(
            array,
            tileKey,
            styleSetEvaluator,
            projection,
            geometries
        );
        const meshHeightRange = this.processMeshFeatures(tileKey, styleSetEvaluator, geometries);
        const minGeometryHeight = Math.min(
            lineHeightRange.minGeometryHeight,
            meshHeightRange.minGeometryHeight
        );
        const maxGeometryHeight = Math.max(
            lineHeightRange.maxGeometryHeight,
            meshHeightRange.maxGeometryHeight
        );

        const dependencies: number[] = [];
        this.processDependencies(array, dependencies);

        const decodedTile: DecodedTile = {
            techniques: styleSetEvaluator.techniques,
            geometries,
            dependencies,
            maxGeometryHeight,
            minGeometryHeight
        };
        return Promise.resolve(decodedTile);
    }

    private createLineGeometry(lineGroup: LineGroup, techniqueIndex: number, id: number) {
        const { vertices, indices } = lineGroup;
        const buffer = new Float32Array(vertices).buffer as ArrayBuffer;
        const index = new Uint32Array(indices).buffer as ArrayBuffer;
        const attr: InterleavedBufferAttribute = {
            type: "float",
            stride: lineGroup.stride,
            buffer,
            attributes: lineGroup.vertexAttributes
        };
        const geometry: Geometry = {
            type: GeometryType.SolidLine,
            index: {
                buffer: index,
                itemCount: 1,
                type: "uint32",
                name: "index"
            },
            interleavedVertexAttributes: [attr],
            groups: [
                {
                    start: 0,
                    count: indices.length,
                    technique: techniqueIndex
                }
            ],
            vertexAttributes: [],
            objInfos: [
                {
                    id: id
                }
            ]
        };

        return geometry;
    }

    private processLineFeatures(
        data: Float32Array,
        tileKey: TileKey,
        styleSetEvaluator: StyleSetEvaluator,
        projection: Projection,
        geometries: Geometry[]
    ): { minGeometryHeight: number; maxGeometryHeight: number } {
        const row = data[0];
        const column = data[1];
        const level = data[2];
        const id = TileKey.fromRowColumnLevel(row, column, level).mortonCode();
        // Setup an environment for this "layer". This does normally come from the data and should
        // contain all the attributes of a specific feature, so that it can be styled properly.
        const env = new MapEnv({ layer: "line-layer", id: id });

        const techniques = styleSetEvaluator.getMatchingTechniques(env);

        const geoCenter = webMercatorTilingScheme.getGeoBox(tileKey).center;
        const worldCenter = projection.projectPoint(geoCenter, new Vector3());

        // Convert the input coordinates to local world coord coordinates (i.e. projected world
        // coordinates relative to the tile center in world coordinates)
        const worldPoints = this.convertToLocalWorldCoordinates(
            data,
            geoCenter,
            projection,
            worldCenter
        );

        // Create actual line-geometry out of the data.
        const lineGroup = new LineGroup();
        lineGroup.add(worldCenter, worldPoints, projection);

        for (const technique of techniques) {
            geometries.push(this.createLineGeometry(lineGroup, technique._index, id));
        }

        return { minGeometryHeight: MIN_GEOMETRY_HEIGHT, maxGeometryHeight: 0 };
    }

    private convertToLocalWorldCoordinates(
        data: Float32Array,
        geoCenter: GeoCoordinates,
        projection: Projection,
        worldCenter: Vector3
    ) {
        // We assume that the input data is in relative-geo-coordinates
        // (i.e. relative lat/long to the tile center). The first 3 numbers are taken for the id
        // hence we start at the 3rd index. This has the number of points, the points are after
        // that.

        const offset = 3;
        const numPoints = data[offset];
        const tmpGeoPoint = geoCenter.clone();
        const tmpWorldPoint = new Vector3();
        const worldPoints = new Array<number>((numPoints / 2) * 3);
        for (let i = 0; i < numPoints; i += 2) {
            tmpGeoPoint.copy(geoCenter);
            // We add +1 to skip the first entry which has the number of points
            tmpGeoPoint.latitude += data[offset + i + 1];
            tmpGeoPoint.longitude += data[offset + i + 2];
            tmpGeoPoint.altitude = MIN_GEOMETRY_HEIGHT;
            projection.projectPoint(tmpGeoPoint, tmpWorldPoint);
            tmpWorldPoint.sub(worldCenter).toArray(worldPoints, (i / 2) * 3);
        }
        return worldPoints;
    }

    private processMeshFeatures(
        tileKey: TileKey,
        styleSetEvaluator: StyleSetEvaluator,
        geometries: Geometry[]
    ): { minGeometryHeight: number; maxGeometryHeight: number } {
        const env = new MapEnv({ layer: "mesh-layer" });
        const techniques = styleSetEvaluator.getMatchingTechniques(env);

        // Scale the mesh so that its size is relative to the tile size.
        const scale = (1 << 20) / (1 << tileKey.level);
        const boxGeometry = new BoxBufferGeometry(1.0 * scale, 5.0 * scale, 5.0 * scale);
        const matrix = new Matrix4();
        matrix.makeTranslation(2.0 * scale, 1.0 * scale, 0);
        boxGeometry.applyMatrix4(matrix);

        // box is centered vertically.
        const geometryHeight = 2.5 * scale;

        for (const technique of techniques) {
            const geometry = ThreeBufferUtils.fromThreeBufferGeometry(
                boxGeometry,
                technique._index
            );
            geometries.push(geometry);
        }

        return { minGeometryHeight: -geometryHeight, maxGeometryHeight: geometryHeight };
    }

    private processDependencies(data: Float32Array, dependencies: number[]) {
        const initialOffset = 3;
        const numberPoints = data[initialOffset];
        const numberDependenciesIndex = numberPoints + 1 + initialOffset;
        // Add 1 because we need to skip the first element
        const numberDependencies = data[numberDependenciesIndex];
        // The format of each dependency is row, column, level, because we can't store the
        // mortonCode in 32bits safely. I could have split into two 32 bit values, but that makes
        // the code harder to read and debug, so this is fine, and the number of dependent tiles is
        // generally not too big.

        // Add 1 to skip the numberDependencies value
        const offset = numberDependenciesIndex + 1;
        for (let i = 0; i < numberDependencies; i += 3) {
            const row = data[offset + i];
            const column = data[offset + i + 1];
            const level = data[offset + i + 2];
            dependencies.push(TileKey.fromRowColumnLevel(row, column, level).mortonCode());
        }
    }
}

// snippet:custom_datasource_example_custom_decoder_service.ts
export class CustomDecoderService {
    static start() {
        WorkerServiceManager.getInstance().register({
            serviceType: CUSTOM_DECODER_SERVICE_TYPE,
            factory: (serviceId: string) => TileDecoderService.start(serviceId, new CustomDecoder())
        });
    }
}
// end:custom_datasource_example_custom_decoder_service.ts
