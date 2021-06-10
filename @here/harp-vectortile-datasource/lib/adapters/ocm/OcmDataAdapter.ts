/*
 * Copyright (C) 2019-2021 HERE Europe B.V.
 * Licensed under Apache 2.0, see full license in LICENSE
 * SPDX-License-Identifier: Apache-2.0
 */

import { Env, MapEnv, ValueMap } from "@here/harp-datasource-protocol/index-decoder";
import {
    GeoBox,
    GeoPointLike,
    hereTilingScheme,
    OrientedBox3,
    pduEquirectangularProjection,
    Projection,
    TileKey,
    TilingScheme,
    Vector2Like,
    webMercatorProjection
} from "@here/harp-geoutils";
import { ILogger, Logger, LoggerManager } from "@here/harp-utils";
import { ShapeUtils, Vector2, Vector3 } from "three";

import { DataAdapter } from "../../DataAdapter";
import { DecodeInfo } from "../../DecodeInfo";
import { IGeometryProcessor, ILineGeometry, IPolygonGeometry } from "../../IGeometryProcessor";
import { isArrayBufferLike, world2tile, WorldTileProjectionCookie } from "../../OmvUtils";
import { IOcmData, IOcmFeature } from "./IOcmData";

const logger = LoggerManager.instance.create("OcmDataAdapter");

function decodeFeatureId(feature: any, logger?: ILogger): number | string | undefined {
    if (feature.hasOwnProperty("id")) {
        const id = feature.id;
        if (typeof id === "number") {
            return id;
        } else if (id) {
            if (logger !== undefined && id.greaterThan(Number.MAX_SAFE_INTEGER)) {
                logger.error(
                    "Invalid ID: Larger than largest available Number in feature: ",
                    feature
                );
            }
            return id.toNumber();
        }
    }

    return undefined;
}

function readAttributes(feature: IOcmFeature, defaultAttributes: ValueMap = {}): ValueMap {
    // TODO: Read feature attributes and insert them into a value map.
    // Optional: Convert attributes to OMV so that a OMV style can be used directly.
    return Object.assign(defaultAttributes, feature.properties);
}

export function createFeatureEnv(
    layerName: string,
    feature: any,
    geometryType: string,
    storageLevel: number,
    storageLevelOffset?: number,
    logger?: ILogger,
    parent?: Env
): MapEnv {
    const attributes: ValueMap = {
        $layer: layerName,
        $level: storageLevel,
        $zoom: Math.max(0, storageLevel - (storageLevelOffset ?? 0)),
        $geometryType: geometryType
    };

    // Some sources serve `id` directly as `IFeature` property ...
    const featureId = decodeFeatureId(feature, logger);
    if (featureId !== undefined) {
        attributes.$id = featureId;
    }

    readAttributes(feature, attributes);

    return new MapEnv(attributes, parent);
}

// Ensures ring winding follows Mapbox Vector Tile specification: outer rings must be clockwise,
// inner rings counter-clockwise.
// See https://docs.mapbox.com/vector-tiles/specification/
function checkWinding(multipolygon: IPolygonGeometry[]) {
    const firstPolygon = multipolygon[0];

    if (firstPolygon === undefined || firstPolygon.rings.length === 0) {
        return;
    }

    // Opposite sign to ShapeUtils.isClockWise, since webMercator tile space has top-left origin.
    // For example:
    // Given the ring = [(1,2), (2,2), (2,1), (1,1)]
    // ShapeUtils.area(ring) > 0    -> false
    // ShapeUtils.isClockWise(ring) -> true
    // ^
    // |  1,2 -> 2,2
    // |          |
    // |  1,1 <- 2,1
    // |_______________>
    //
    // Tile space axis
    //  ______________>
    // |  1,1 <- 2,1
    // |          |
    // |  1,2 ->  2,2
    // V
    const isOuterRingClockWise = ShapeUtils.area(firstPolygon.rings[0]) > 0;

    if (!isOuterRingClockWise) {
        for (const polygon of multipolygon) {
            for (const ring of polygon.rings) {
                ring.reverse();
            }
        }
    }
}

const DEFAULT_EXTENTS = 4 * 1024;

class OcmDecodeInfo {
    readonly geoBox: GeoBox;

    readonly projectedBoundingBox = new OrientedBox3();

    worldTileProjectionCookie?: WorldTileProjectionCookie;

    constructor(readonly tileKey: TileKey) {
        this.geoBox = this.tilingScheme.getGeoBox(tileKey);
    }

    /**
     * The [[TilingScheme]] of the OMV data, currenly it is defined
     * to be [[webMercatorTilingScheme]].
     */
    get tilingScheme(): TilingScheme {
        return hereTilingScheme;
    }

    /**
     * The [[Projection]] of OMV tiled data, currenly it is defined
     * to be [[webMercatorProjection]].
     */
    get sourceProjection(): Projection {
        return pduEquirectangularProjection;
    }
}

/**
 * The class `OcmDataAdapter` converts OMV protobuf geo data
 * to geometries for the given `IGeometryProcessor`.
 */

export class OcmDataAdapter implements DataAdapter {
    id = "omv-protobuf";

    private readonly m_processor: IGeometryProcessor;
    private readonly m_logger?: ILogger;

    private m_decodeInfo!: OcmDecodeInfo;
    private readonly m_layer!: any;

    /**
     * Constructs a new [[OmvProtobufDataAdapter]].
     *
     * @param processor - The [[IGeometryProcessor]] used to process the data.
     * @param dataFilter - The [[OmvFeatureFilter]] used to filter features.
     * @param logger - The [[ILogger]] used to log diagnostic messages.
     */
    constructor(processor: IGeometryProcessor, logger?: ILogger) {
        this.m_processor = processor;
        this.m_logger = logger;
    }

    /**
     * Checks that the given data can be processed by this [[OmvProtobufDataAdapter]].
     */
    canProcess(data: ArrayBufferLike | {}): boolean {
        // TODO: VectorTileDecoder relies on each adapter identifying the data they can process.
        // So far this adapter is checked last, so return true for everything that is an object.
        // Other adapters recognize their data by the presence of some object attribute.
        // Another option would be that the DataProvider already tells what adapter should be used.
        return !isArrayBufferLike(data);
    }

    /**
     * Processes the given data payload using this adapter's [[IGeometryProcessor]].
     *
     * @param data - The data payload to process.
     * @param decodeInfo - The [[DecodedInfo]] of the tile to proceess.
     */
    process(data: {}, decodeInfo: DecodeInfo) {
        const ocmData: IOcmData = data;
        this.m_decodeInfo = new OcmDecodeInfo(decodeInfo.tileKey);
        for (var [layerName, features] of Object.entries(ocmData)) {
            //logger.log(`Layer ${layerName} has ${features.length} features`);
            this.visitLayer(layerName, features);
        }
    }

    /**
     * Visits the OCM layer.
     *
     * @param layer - The OCM layer to process.
     */
    private visitLayer(name: string, features: IOcmFeature[]): boolean {
        for (const feature of features) {
            switch (feature.geometry.type) {
                case "Point":
                    this.visitPointFeature(feature, name);
                    break;
                case "Line":
                    this.visitLineFeature(feature, name);
                    break;
                case "Polygon":
                    this.visitPolygonFeature(feature, name);
                    break;
            }
        }

        return true;
    }

    private toWebMercatorTile<VectorType extends Vector2Like>(
        tileGeoPoint: GeoPointLike,
        target: VectorType
    ): VectorType {
        const swCorner = this.m_decodeInfo.geoBox.southWest;
        const geoCoords = this.m_decodeInfo.sourceProjection.unprojectPoint({
            x: tileGeoPoint[0],
            y: tileGeoPoint[1],
            z: 0
        });
        geoCoords.latitude += swCorner.latitude;
        geoCoords.longitude += swCorner.longitude;
        geoCoords.altitude = geoCoords.altitude
            ? geoCoords.altitude + (swCorner.altitude ?? 0)
            : undefined;
        const worldCoords = webMercatorProjection.projectPoint(geoCoords, new Vector3());

        return world2tile<VectorType>(
            DEFAULT_EXTENTS,
            this.m_decodeInfo as DecodeInfo,
            worldCoords,
            false,
            target
        );
    }

    /**
     * Visits point features.
     *
     * @param feature - The OCM point features to process.
     */
    private visitPointFeature(feature: IOcmFeature, layerName: string): void {
        const storageLevel = this.m_decodeInfo.tileKey.level;
        const webMTileCoords = this.toWebMercatorTile(
            feature.geometry.coordinates as GeoPointLike,
            new Vector3()
        );

        const env = createFeatureEnv(
            layerName,
            feature,
            "point",
            storageLevel,
            this.m_processor.storageLevelOffset,
            this.m_logger
        );

        this.m_processor.processPointFeature(
            layerName,
            DEFAULT_EXTENTS,
            [webMTileCoords],
            env,
            storageLevel
        );
    }

    /**
     * Visits the line features.
     *
     * @param feature - The line features to process.
     */
    private visitLineFeature(feature: IOcmFeature, layerName: string): void {
        const storageLevel = this.m_decodeInfo.tileKey.level;
        const line = feature.geometry.coordinates as GeoPointLike[];
        if (line.length === 0) {
            return;
        }
        const webMTileCoords: Vector2[] = [];
        const geometry: ILineGeometry[] = [{ positions: webMTileCoords }];

        for (const point of line) {
            webMTileCoords.push(this.toWebMercatorTile(point, new Vector2()));
        }

        const env = createFeatureEnv(
            layerName,
            feature,
            "line",
            storageLevel,
            this.m_processor.storageLevelOffset,
            this.m_logger
        );

        this.m_processor.processLineFeature(
            layerName,
            DEFAULT_EXTENTS,
            geometry,
            env,
            storageLevel
        );
    }

    /**
     * Visits the polygon features.
     *
     * @param feature - The polygon features to process.
     */
    private visitPolygonFeature(feature: IOcmFeature, layerName: string): void {
        const storageLevel = this.m_decodeInfo.tileKey.level;

        const srcGeometry = feature.geometry.coordinates as GeoPointLike[][];
        if (srcGeometry.length === 0) {
            return;
        }

        const geometry: IPolygonGeometry[] = [];
        let currentPolygon: IPolygonGeometry | undefined;

        for (const srcRing of srcGeometry) {
            const currentRing: Vector2[] = [];
            for (const point of srcRing) {
                currentRing.push(this.toWebMercatorTile(point, new Vector2()));
            }

            let exteriorWinding: number | undefined;
            if (currentRing.length > 0) {
                const currentRingWinding = Math.sign(ShapeUtils.area(currentRing));
                // Winding order from XYZ spaces might be not MVT spec compliant, see HARP-11151.
                // We take the winding of the very first ring as reference.
                if (exteriorWinding === undefined) {
                    exteriorWinding = currentRingWinding;
                }
                // MVT spec defines that each exterior ring signals the beginning of a new polygon.
                // see https://github.com/mapbox/vector-tile-spec/tree/master/2.1
                if (currentRingWinding === exteriorWinding) {
                    // Create a new polygon and push it into the collection of polygons
                    currentPolygon = { rings: [] };
                    geometry.push(currentPolygon);
                }
                // Push the ring into the current polygon
                currentRing.push(currentRing[0].clone());
                currentPolygon?.rings.push(currentRing);
            }
        }
        if (geometry.length === 0) {
            return;
        }

        checkWinding(geometry);

        const env = createFeatureEnv(
            layerName,
            feature,
            "polygon",
            storageLevel,
            this.m_processor.storageLevelOffset,
            this.m_logger
        );

        this.m_processor.processPolygonFeature(
            layerName,
            DEFAULT_EXTENTS,
            geometry,
            env,
            storageLevel
        );
    }
}
