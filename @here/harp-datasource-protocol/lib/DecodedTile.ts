/*
 * Copyright (C) 2019-2021 HERE Europe B.V.
 * Licensed under Apache 2.0, see full license in LICENSE
 * SPDX-License-Identifier: Apache-2.0
 */

import {
    equirectangularProjection,
    hereTilingScheme,
    mercatorProjection,
    mercatorTilingScheme,
    normalizedEquirectangularProjection,
    OrientedBox3,
    Projection,
    sphereProjection,
    TilingScheme,
    Vector3Like,
    webMercatorProjection,
    webMercatorTilingScheme
} from "@here/harp-geoutils";

import { Env } from "./Expr";
import { AttrEvaluationContext, evaluateTechniqueAttr } from "./TechniqueAttr";
import {
    IndexedTechnique,
    isLineMarkerTechnique,
    isPoiTechnique,
    isTextTechnique,
    Technique
} from "./Techniques";
import { TileInfo } from "./TileInfo";

/**
 * This object has geometry data in the form of geometries buffers ready to be used by WebGL.
 * These geometries are not `three.js` objects. They are pure data stored as `ArrayBuffer`s and
 * metadata describing these buffers.
 */
export interface DecodedTile {
    techniques: IndexedTechnique[];
    geometries: Geometry[];
    pathGeometries?: PathGeometry[];
    textPathGeometries?: TextPathGeometry[];
    textGeometries?: TextGeometry[]; // ### deprecate
    poiGeometries?: PoiGeometry[];
    tileInfo?: TileInfo;
    decodeTime?: number; // time used to decode (in ms)

    /**
     * The default bounding box in [[Tile]] is based on the geo box of the tile.
     * For data-sources that have 3d data this is not sufficient so the data-source can provide a
     * more accurate bounding box once the data is decoded.
     */
    boundingBox?: OrientedBox3;

    /**
     * Data sources not defining a bounding box may define alternatively a maximum geometry height
     * in meters. The bounding box of the resulting tile will be extended to encompass this height.
     */
    maxGeometryHeight?: number;

    /**
     * Data sources not defining a bounding box may define alternatively a minimum geometry height
     * in meters. The bounding box of the resulting tile will be extended to encompass this height.
     */
    minGeometryHeight?: number;

    /**
     * Tile data Copyright holder identifiers.
     *
     * `id`s should be unique. It is recommended to build them from unique identifiers like
     * registered domain names.
     *
     * @see [[CopyrightInfo]]
     */
    copyrightHolderIds?: string[];

    /**
     * List of {@link @here/harp-geoutils#TileKey}s stored as mortonCodes representing
     * {@link @here/harp-mapview#Tile}s that have geometry covering this `Tile`.
     */
    dependencies?: number[];
}

/**
 * This object keeps the path of the geometry. Space of the path depends on the
 * use case, so could be either world or local tile space.
 */
export interface PathGeometry {
    path: Vector3Like[];
}

/**
 * Attributes corresponding to some decoded geometry. It may be either a map
 * of multiple attributes or just a string with the geometry's feature id (id numbers are
 * deprecated).
 */
export type AttributeMap = {} | string | number;

/**
 * This object keeps textual data together with metadata to place it on the map.
 */
export interface TextPathGeometry {
    path: number[];
    pathLengthSqr: number;
    text: string;
    technique: number;
    objInfos?: AttributeMap;
}

/**
 * Returns an array with the data type specified as parameter.
 *
 * @param attr - specifies which type of data is being stored in the array
 */
export function getArrayConstructor(attr: BufferElementType) {
    switch (attr) {
        case "float":
            return Float32Array;
        case "uint8":
            return Uint8Array;
        case "uint16":
            return Uint16Array;
        case "uint32":
            return Uint32Array;
        case "int8":
            return Int8Array;
        case "int16":
            return Int16Array;
        case "int32":
            return Int32Array;
    }
}

/**
 * Structured clone compliant WebGL interleaved buffer with its metadata attached.
 */
export interface InterleavedBufferAttribute {
    buffer: ArrayBufferLike;
    stride: number;
    type: BufferElementType;
    attributes: Array<{
        name: string;
        itemSize: number;
        offset: number;
    }>;
}

/**
 * Geometry types supported by [[Geometry]] objects.
 */
export enum GeometryType {
    Unspecified = 0,
    Point,
    Line,
    SolidLine,
    Text,
    TextPath,
    ExtrudedLine,
    Polygon,
    ExtrudedPolygon,
    Object3D,
    Other = 1000
}

/**
 * Structured clone compliant version of a `three.js` geometry object, consisting of buffers with
 * metadata for map features and objects for example roads, trees or parks.
 */
export interface Geometry {
    type: GeometryType;
    vertexAttributes?: BufferAttribute[];
    interleavedVertexAttributes?: InterleavedBufferAttribute[];
    index?: BufferAttribute;
    edgeIndex?: BufferAttribute;
    groups: Group[];
    uuid?: string;

    /**
     * Optional sorted list of feature start indices. The indices point into the index attribute.
     * Feature i starts at featureStarts[i] and ends at featureStarts[i+1]-1, except for the last
     * feature, which ends at index[index.length-1].
     */
    featureStarts?: number[];

    /**
     * Optional sorted list of feature start indices for the outline geometry.
     * Equivalent to {@link featureStarts} but pointing into the edgeIndex attribute.
     */
    edgeFeatureStarts?: number[];

    /**
     * Optional array of objects. It can be used to pass user data from the geometry to the mesh.
     */
    objInfos?: AttributeMap[];

    /**
     * Optional [[Array]] of [[Attachment]]s.
     */
    attachments?: Attachment[];
}

/**
 * Attachments together with [[Geometry]] define the meshes and the objects
 * of a [[Scene]].
 */
export interface Attachment {
    /**
     * The unique uuid of this [[Attachment]].
     */
    uuid?: string;

    /**
     * The name of this [[Attachment]].
     */
    name?: string;

    /**
     * The index [[BufferAttribute]]. If not provided the index
     * buffer of the [[Geometry]] will be used.
     */
    index?: BufferAttribute;

    /**
     * Optional additional buffer index used to create an edge object.
     */
    edgeIndex?: BufferAttribute;

    /**
     * The draw [[Group]]]s of this [[Attachment]].
     */
    groups: Group[];
}

/**
 * The data stored in Buffers' elements can be of the following elementary types: float, signed or
 * unsigned integers (8-bit, 16-bit or 32-bit long).
 */
export type BufferElementType =
    | "float"
    | "uint8"
    | "uint16"
    | "uint32"
    | "int8"
    | "int16"
    | "int32";

/**
 * Structured clone compliant WebGL buffer and its metadata.
 */
export interface BufferAttribute {
    name: string;
    buffer: ArrayBufferLike;
    type: BufferElementType;
    itemCount: number;
    normalized?: boolean;
}

/**
 * Structured clone compliant version of a `three.js` geometry object with text to be rendered.
 * It is composed of buffers with metadata for text objects.
 */
export interface TextGeometry {
    positions: BufferAttribute;
    texts: number[];
    technique?: number;
    stringCatalog: Array<string | undefined>;
    objInfos?: AttributeMap[];
}

/**
 * Structured clone compliant version of a `three.js` geometry object with points of interest (POIs)
 * to be rendered. It is composed of buffers with metadata for POI objects.
 */
export interface PoiGeometry extends TextGeometry {
    /**
     * Names of the image texture or the name of the POI as indices into the array `stringCatalog`.
     */
    imageTextures?: number[];
    // Angle in degrees from north clockwise specifying the directions the icons can be shifted.
    offsetDirections?: number[];
}

/**
 * Structured clone compliant WebGL group object and its metadata.
 * Its purpose is to make working with groups of objects easier.
 */
export interface Group {
    start: number;
    count: number;
    technique: number;

    /**
     * Contains tile offsets if its [[Geometry]] has been created.
     */
    createdOffsets?: number[];
}

/**
 * Returns the projection object specified in the parameter.
 *
 * @param projectionName - string describing projection to be used
 */
export function getProjection(projectionName: string): Projection | never {
    switch (projectionName) {
        case "mercator":
            return mercatorProjection;
        case "webMercator":
            return webMercatorProjection;
        case "sphere":
            return sphereProjection;
        case "normalizedEquirectangular":
            return normalizedEquirectangularProjection;
        case "equirectangular":
            return equirectangularProjection;
        default:
            throw new Error(`Unknown projection ${projectionName}`);
    } // switch
}

/**
 * String with the projection's name.
 *
 * @param projection - `Projection` object containing the name of the projection to retrieve
 */
export function getProjectionName(projection: Projection): string | never {
    if (projection === mercatorProjection) {
        return "mercator";
    } else if (projection === webMercatorProjection) {
        return "webMercator";
    } else if (projection === sphereProjection) {
        return "sphere";
    } else if (projection === normalizedEquirectangularProjection) {
        return "normalizedEquirectangular";
    } else if (projection === equirectangularProjection) {
        return "equirectangular";
    }
    throw new Error("Unknown projection");
}

export function getTilingScheme(projectionName: string): TilingScheme | never {
    switch (projectionName) {
        case "mercator":
            return mercatorTilingScheme;
        case "webMercator":
            return webMercatorTilingScheme;
        case "normalizedEquirectangular":
            return hereTilingScheme;
        default:
            throw new Error(`Unknown tilingScheme ${projectionName}`);
    } // switch
}

export function getTilingSchemeName(tilingScheme: TilingScheme): string | never {
    if (tilingScheme === mercatorTilingScheme) {
        return "mercator";
    } else if (tilingScheme === webMercatorTilingScheme) {
        return "webMercator";
    } else if (tilingScheme === hereTilingScheme) {
        return "normalizedEquirectangular";
    }
    throw new Error("Unknown projection");
}
/**
 * @returns Feature id from the provided attribute map.
 * @internal
 */
export function getFeatureId(attributeMap: AttributeMap | undefined): string | number {
    if (attributeMap === undefined) {
        return 0;
    }

    if (typeof attributeMap === "string" || typeof attributeMap === "number") {
        return attributeMap;
    } else if (attributeMap.hasOwnProperty("$id")) {
        const id = (attributeMap as any).$id;

        if (typeof id === "string" || typeof id === "number") {
            return id;
        }
    }

    return 0;
}

/**
 * Determine the name of (OMV) feature. It implements the special handling required
 * to determine the text content of a feature from its tags, which are passed in as the `env`.
 *
 * @param env - Environment containing the tags from the (OMV) feature.
 * @param useAbbreviation - `true` to use the abbreviation if available.
 * @param useIsoCode - `true` to use the tag "iso_code".
 * @param languages - List of languages to use, for example: Specify "en" to use the tag "name_en"
 *                  as the text of the string. Order reflects priority.
 */
export function getFeatureName(
    env: Env,
    basePropName: string | undefined,
    useAbbreviation?: boolean,
    useIsoCode?: boolean,
    languages?: string[]
): string | undefined {
    let name;
    if (basePropName === undefined) {
        basePropName = "name";
    }
    if (useAbbreviation) {
        const abbreviation = env.lookup(`${basePropName}:short`);
        if (typeof abbreviation === "string" && abbreviation.length > 0) {
            return abbreviation;
        }
    }
    if (useIsoCode) {
        const isoCode = env.lookup(`iso_code`);
        if (typeof isoCode === "string" && isoCode.length > 0) {
            return isoCode;
        }
    }
    if (languages !== undefined) {
        for (const lang of languages) {
            name = env.lookup(`${basePropName}:${lang}`) ?? env.lookup(`${basePropName}_${lang}`);
            if (typeof name === "string" && name.length > 0) {
                return name;
            }
        }
    }
    name = env.lookup(basePropName);
    if (typeof name === "string") {
        return name;
    }
    return undefined;
}

/**
 * Determine the text string of the map feature. It implements the special handling required
 * to determine the text content of a feature from its tags, which are passed in as the `env`.
 *
 * @param feature - Feature, including properties from the (OMV) feature.
 * @param technique - technique defining how text should be created from feature
 * @param languages - List of languages to use, for example: Specify "en" to use the tag "name_en"
 *                  as the text of the string. Order reflects priority.
 */
export function getFeatureText(
    context: Env | AttrEvaluationContext,
    technique: Technique,
    languages?: string[]
): string | undefined {
    let useAbbreviation: boolean | undefined;
    let useIsoCode: boolean | undefined;
    const env = context instanceof Env ? context : context.env;
    let propName: string = "name";
    if (
        isTextTechnique(technique) ||
        isPoiTechnique(technique) ||
        isLineMarkerTechnique(technique)
    ) {
        if (technique.text !== undefined) {
            return evaluateTechniqueAttr(context, technique.text);
        }
        if (technique.label !== undefined) {
            propName = evaluateTechniqueAttr(context, technique.label)!;
            if (typeof propName !== "string") {
                return undefined;
            }
        }
        useAbbreviation = technique.useAbbreviation;
        useIsoCode = technique.useIsoCode;
    }

    return getFeatureName(env, propName, useAbbreviation, useIsoCode, languages);
}

/**
 * Determine whether to scale heights by the projection scale factor for geometry
 * using the given technique.
 * @remarks Unless explicitly defined, the scale factor to convert meters to world space units
 * won't be applied if the tile's level is less than a fixed storage level.
 * @param context - Context for evaluation of technique attributes.
 * @param technique - Technique to be evaluated.
 * @param tileLevel - The level of the tile where the geometry is stored.
 * @returns `true` if height must be scaled, `false` otherwise.
 */
export function scaleHeight(
    context: Env | AttrEvaluationContext,
    technique: Technique,
    tileLevel: number
): boolean {
    const SCALED_HEIGHT_MIN_STORAGE_LEVEL = 12;
    const useConstantHeight = evaluateTechniqueAttr(
        context,
        technique.constantHeight,
        tileLevel < SCALED_HEIGHT_MIN_STORAGE_LEVEL
    );
    return !useConstantHeight;
}
