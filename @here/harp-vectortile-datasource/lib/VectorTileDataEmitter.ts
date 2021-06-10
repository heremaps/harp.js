/*
 * Copyright (C) 2019-2021 HERE Europe B.V.
 * Licensed under Apache 2.0, see full license in LICENSE
 * SPDX-License-Identifier: Apache-2.0
 */
import {
    AttributeMap,
    BufferAttribute,
    composeTechniqueTextureName,
    DecodedTile,
    ExtrudedPolygonTechnique,
    FillTechnique,
    Geometry,
    GeometryType,
    getFeatureId,
    getFeatureText,
    Group,
    IndexedTechnique,
    InterleavedBufferAttribute,
    isExtrudedLineTechnique,
    isExtrudedPolygonTechnique,
    isFillTechnique,
    isLabelRejectionLineTechnique,
    isLineMarkerTechnique,
    isLineTechnique,
    isPoiTechnique,
    isShaderTechnique,
    isSolidLineTechnique,
    isSpecialDashesLineTechnique,
    isStandardTechnique,
    isTextTechnique,
    LineMarkerTechnique,
    PathGeometry,
    PoiGeometry,
    PoiTechnique,
    scaleHeight,
    StyleColor,
    Technique,
    TextGeometry,
    TextPathGeometry,
    TextTechnique,
    TextureCoordinateType,
    textureCoordinateType
} from "@here/harp-datasource-protocol";
import {
    Env,
    IMeshBuffers,
    StyleSetEvaluator,
    Value
} from "@here/harp-datasource-protocol/index-decoder";
import {
    AttrEvaluationContext,
    evaluateTechniqueAttr
} from "@here/harp-datasource-protocol/lib/TechniqueAttr";
import { clipPolygon } from "@here/harp-geometry/lib/ClipPolygon";
import {
    EdgeLengthGeometrySubdivisionModifier,
    SubdivisionMode
} from "@here/harp-geometry/lib/EdgeLengthGeometrySubdivisionModifier";
import { SphericalGeometrySubdivisionModifier } from "@here/harp-geometry/lib/SphericalGeometrySubdivisionModifier";
import {
    GeoBox,
    GeoCoordinates,
    normalizedEquirectangularProjection,
    ProjectionType,
    Vector3Like,
    webMercatorProjection
} from "@here/harp-geoutils";
import { LineGroup } from "@here/harp-lines/lib/Lines";
import { triangulateLine } from "@here/harp-lines/lib/TriangulateLines";
import { ExtrusionFeatureDefs } from "@here/harp-materials/lib/MapMeshMaterialsDefs";
import { assert, getOptionValue, LoggerManager, Math2D } from "@here/harp-utils";
import earcut from "earcut";
import * as THREE from "three";

import { DecodeInfo } from "./DecodeInfo";
import { ILineGeometry, IPolygonGeometry } from "./IGeometryProcessor";
import {
    tile2world,
    webMercatorTile2TargetTile,
    webMercatorTile2TargetWorld,
    world2tile
} from "./OmvUtils";
import { Ring } from "./Ring";

const logger = LoggerManager.instance.create("OmvDecodedTileEmitter");

const tempTileOrigin = new THREE.Vector3();
const tempVertNormal = new THREE.Vector3();
const tempFootDisp = new THREE.Vector3();
const tempRoofDisp = new THREE.Vector3();

const tmpV2 = new THREE.Vector2();
const tmpV2r = new THREE.Vector2();
const tmpV3 = new THREE.Vector3();
const tmpV3r = new THREE.Vector3();
const tmpV4 = new THREE.Vector3();

const tempP0 = new THREE.Vector2();
const tempP1 = new THREE.Vector2();
const tempPreviousTangent = new THREE.Vector2();

const tmpPointA = new THREE.Vector3();
const tmpPointB = new THREE.Vector3();
const tmpPointC = new THREE.Vector3();
const tmpPointD = new THREE.Vector3();
const tmpPointE = new THREE.Vector3();
const tmpLine = new THREE.Line3();

/**
 * Minimum number of pixels per character. Used during estimation if there is enough screen space
 * available to render a text. Based on the estimated screen size of a tile.
 */
const MIN_AVERAGE_CHAR_WIDTH = 5;

/**
 * Estimation "fudge factor", tweaking the size estimation to
 *
 * a) allow room for zooming in to the tile, and
 *
 * b) allow for some tilting, where the edge of a tile closer to the camera has more space.
 *
 * Useful values are between 0 (allow all labels), 0.5 (allow labels at twice the default display
 * size of the tile) and 1.0 (skip labels that would normally not be displayed at default tile
 * size).
 */
const SIZE_ESTIMATION_FACTOR = 0.5;

/**
 * Maximum allowed corner angle inside a label path.
 */
const MAX_CORNER_ANGLE = Math.PI / 8;

/**
 * Used to identify an invalid (or better: unused) array index.
 */
const INVALID_ARRAY_INDEX = -1;

function createIndexBufferAttribute(
    elements: ArrayLike<number>,
    maxValue: number,
    name: string = "index"
): BufferAttribute {
    const type = maxValue > 65535 ? "uint32" : "uint16";
    const storage = type === "uint32" ? new Uint32Array(elements) : new Uint16Array(elements);
    const buffer = storage.buffer;
    return {
        itemCount: 1,
        name,
        buffer,
        type
    };
}

interface LinesGeometry {
    type: GeometryType;
    lines: LineGroup;
    technique: number;

    /**
     * Optional array of objects. It can be used to pass user data from the geometry to the mesh.
     */
    objInfos?: AttributeMap[];

    /**
     * Optional list of feature start indices. The indices point into the index attribute.
     */
    featureStarts?: number[];
}

// for tilezen by default extrude all buildings even those without height data
class MeshBuffers implements IMeshBuffers {
    readonly positions: number[] = [];
    readonly normals: number[] = [];
    readonly textureCoordinates: number[] = [];
    readonly colors: number[] = [];
    readonly extrusionAxis: number[] = [];
    readonly indices: number[] = [];
    readonly edgeIndices: number[] = [];
    readonly groups: Group[] = [];
    readonly texts: number[] = [];
    readonly pathLengths: number[] = [];
    readonly stringCatalog: Array<string | undefined> = [];
    readonly imageTextures: number[] = [];

    /**
     * Optional list of feature start indices. The indices point into the index attribute.
     */
    readonly featureStarts: number[] = [];

    /**
     * Optional list of edge feature start indices. The indices point into the edge index attribute.
     */
    readonly edgeFeatureStarts: number[] = [];

    /**
     * An optional list of additional data that can be used as additional data for the object
     * picking.
     */
    readonly objInfos: AttributeMap[] = [];

    /**
     * Angle in degrees from north clockwise which represents the direction the icons can be
     * shifted.
     */
    readonly offsetDirections: number[] = [];

    constructor(readonly type: GeometryType) {}

    addText(text: string) {
        let index = this.stringCatalog.indexOf(text);

        if (index < 0) {
            index = this.stringCatalog.length;
            this.stringCatalog.push(text);
        }
        return index;
    }
}

enum LineType {
    Simple,
    Complex
}

type TexCoordsFunction = (tilePos: THREE.Vector2, tileExtents: number) => THREE.Vector2;
const tmpColor = new THREE.Color();

export class VectorTileDataEmitter {
    // mapping from style index to mesh buffers
    private readonly m_meshBuffers = new Map<number, MeshBuffers>();

    private readonly m_geometries: Geometry[] = [];
    private readonly m_textGeometries: TextGeometry[] = [];
    private readonly m_textPathGeometries: TextPathGeometry[] = [];
    private readonly m_pathGeometries: PathGeometry[] = [];
    private readonly m_poiGeometries: PoiGeometry[] = [];
    private readonly m_simpleLines: LinesGeometry[] = [];
    private readonly m_solidLines: LinesGeometry[] = [];

    private readonly m_sources: string[] = [];
    private m_maxGeometryHeight: number = 0;
    private m_minGeometryHeight: number = 0;

    constructor(
        private readonly m_decodeInfo: DecodeInfo,
        private readonly m_styleSetEvaluator: StyleSetEvaluator,
        private readonly m_gatherFeatureAttributes: boolean,
        private readonly m_skipShortLabels: boolean,
        private readonly m_enableElevationOverlay: boolean,
        private readonly m_languages?: string[]
    ) {}

    get projection() {
        return this.m_decodeInfo.targetProjection;
    }

    get center() {
        return this.m_decodeInfo.center;
    }

    /**
     * Creates the Point of Interest geometries for the given feature.
     *
     * @param layer - Tile's layer to be processed.
     * @param extents - Tile's layer extents.
     * @param geometry - The feature geometry in local webMercator coordinates.
     * @param env - The [[MapEnv]] containing the environment information for the map.
     * @param techniques - The array of [[Technique]] that will be applied to the geometry.
     */
    processPointFeature(
        layer: string,
        extents: number,
        geometry: THREE.Vector3[],
        context: AttrEvaluationContext,
        techniques: IndexedTechnique[]
    ): void {
        const env = context.env;
        this.processFeatureCommon(env);

        const { tileKey, columnCount, rowCount } = this.m_decodeInfo;

        // adjust the extents to ensure that points on the right and bottom edges
        // of the tile are discarded.
        const xextent = tileKey.column + 1 < columnCount ? extents - 1 : extents;
        const yextent = tileKey.row + 1 < rowCount ? extents - 1 : extents;

        // get the point positions (in tile space) that are inside the tile bounds.
        const tilePositions = geometry.filter(p => {
            // TODO: CHECK WHY HALF OF THE TILE IS FILTERED OUT.
            //return p.x >= 0 && p.x <= xextent && p.y >= 0 && p.y <= yextent;
            return true;
        });

        if (tilePositions.length === 0) {
            // nothing to do, no geometry within the tile bound.
            return;
        }

        for (const technique of techniques) {
            if (technique === undefined) {
                continue;
            }

            const techniqueIndex = technique._index;
            const meshBuffers = this.findOrCreateMeshBuffers(techniqueIndex, GeometryType.Point);

            if (meshBuffers === undefined) {
                continue;
            }

            const { positions, texts, imageTextures, objInfos, offsetDirections } = meshBuffers;

            const shouldCreateTextGeometries =
                isTextTechnique(technique) || isPoiTechnique(technique);

            let imageTexture: string | undefined;
            const wantsPoi = isPoiTechnique(technique);

            if (wantsPoi) {
                const poiTechnique = technique as PoiTechnique;
                imageTexture = evaluateTechniqueAttr(context, poiTechnique.imageTexture);

                // TODO: Move to decoder independent parts of code.
                if (poiTechnique.poiName !== undefined) {
                    imageTexture = evaluateTechniqueAttr(context, poiTechnique.poiName);
                } else if (typeof poiTechnique.poiNameField === "string") {
                    const poiNameFieldValue = env.lookup(poiTechnique.poiNameField) as string;
                    imageTexture = poiNameFieldValue;
                } else if (typeof poiTechnique.imageTextureField === "string") {
                    const imageTextureValue = env.lookup(poiTechnique.imageTextureField) as string;
                    imageTexture = composeTechniqueTextureName(imageTextureValue, poiTechnique);
                }
            }

            const scaleHeights = scaleHeight(context, technique, this.m_decodeInfo.tileKey.level);
            const featureId = getFeatureId(env.entries);
            for (const pos of tilePositions) {
                if (shouldCreateTextGeometries) {
                    const textTechnique = technique as TextTechnique;
                    const text = getFeatureText(context, textTechnique, this.m_languages);

                    if (text !== undefined && text.length > 0) {
                        texts.push(meshBuffers.addText(text));
                    } else {
                        texts.push(INVALID_ARRAY_INDEX);
                    }
                }

                // Always store the position, otherwise the following POIs will be
                // misplaced.
                if (shouldCreateTextGeometries) {
                    webMercatorTile2TargetWorld(
                        extents,
                        this.m_decodeInfo,
                        pos,
                        tmpV3,
                        scaleHeights
                    );
                } else {
                    webMercatorTile2TargetTile(
                        extents,
                        this.m_decodeInfo,
                        pos,
                        tmpV3,
                        scaleHeights
                    );
                }
                positions.push(tmpV3.x, tmpV3.y, tmpV3.z);
                objInfos.push(this.m_gatherFeatureAttributes ? env.entries : featureId);
                offsetDirections.push((env.lookup("offset_direction") as number) ?? 0);

                if (wantsPoi) {
                    if (imageTexture === undefined) {
                        imageTextures.push(INVALID_ARRAY_INDEX);
                    } else {
                        imageTextures.push(meshBuffers.addText(imageTexture));
                    }
                }
            }
        }
    }

    /**
     *
     * Creates the line geometries for the given feature.
     *
     * @param layer - Tile's layer to be processed.
     * @param extents - Tile's layer extents.
     * @param geometry - The current feature containing the main geometry.
     * @param env - The [[MapEnv]] containing the environment information for the map.
     * @param techniques - The array of [[Technique]] that will be applied to the geometry.
     */
    processLineFeature(
        layer: string,
        extents: number,
        geometry: ILineGeometry[],
        context: AttrEvaluationContext,
        techniques: IndexedTechnique[]
    ): void {
        const env = context.env;
        this.processFeatureCommon(env);

        const localLines: number[][] = []; // lines in target tile space.
        const worldLines: number[][] = []; // lines in world space.
        const uvs: number[][] = [];
        const offsets: number[][] = [];
        const projectedBoundingBox = this.m_decodeInfo.projectedBoundingBox;

        let localLineSegments: number[][]; // lines in target tile space for special dashes.

        const tileWidth = projectedBoundingBox.extents.x * 2;
        const tileHeight = projectedBoundingBox.extents.y * 2;
        const tileSizeWorld = Math.max(tileWidth, tileHeight);

        let computeTexCoords: TexCoordsFunction | undefined;
        let texCoordinateType: TextureCoordinateType | undefined;

        const hasUntiledLines = geometry[0].untiledPositions !== undefined;
        const scaleHeights = false; // No need to scale height, source data is 2D.

        // If true, special handling for dashes is required (round and diamond shaped dashes).
        let hasIndividualLineSegments = false;
        let hasContinuousLineSegments = false;

        // Check if any of the techniques needs texture coordinates
        for (const technique of techniques) {
            if (technique === undefined) {
                continue;
            }
            if (!computeTexCoords) {
                computeTexCoords = this.getComputeTexCoordsFunc(technique);
                texCoordinateType = this.getTextureCoordinateType(technique);
            } else {
                // Support generation of only one type of texture coordinates.
                const otherTexCoordType = this.getTextureCoordinateType(technique);
                assert(otherTexCoordType === undefined || texCoordinateType === otherTexCoordType);
            }

            hasIndividualLineSegments =
                hasIndividualLineSegments || isSpecialDashesLineTechnique(technique);

            hasContinuousLineSegments = hasContinuousLineSegments || !hasIndividualLineSegments;
        }

        for (const polyline of geometry) {
            // Compute the world position of the untiled line and its distance to the origin of the
            // line to properly join lines.
            const untiledLine: number[] = [];
            let lineDist = 0;
            if (hasUntiledLines) {
                this.m_decodeInfo.targetProjection.projectPoint(
                    polyline.untiledPositions![0],
                    tmpV3r
                );
                polyline.untiledPositions!.forEach(pos => {
                    // Calculate the distance to the next un-normalized point.
                    this.m_decodeInfo.targetProjection.projectPoint(pos, tmpV3);
                    lineDist += tmpV3.distanceTo(tmpV3r);
                    tmpV3r.copy(tmpV3);

                    // Pushed the normalized point for line matching.
                    this.m_decodeInfo.targetProjection.projectPoint(pos.normalized(), tmpV3);
                    untiledLine.push(tmpV3.x, tmpV3.y, tmpV3.z, lineDist);
                });
            }

            // Add continuous line as individual segments to improve special dashes by overlapping
            // their connecting vertices. The technique/style should defined round or rectangular
            // caps.
            if (hasIndividualLineSegments) {
                localLineSegments = [];

                // Compute length of whole line and offsets of individual segments.
                let lineLength = 0;
                const pointCount = polyline.positions.length;
                if (pointCount > 1) {
                    let lastSegmentOffset = 0;

                    for (let i = 0; i < pointCount - 1; i++) {
                        const localLine: number[] = [];
                        const worldLine: number[] = [];
                        const lineUvs: number[] = [];
                        const segmentOffsets: number[] = [];

                        const pos1 = polyline.positions[i];
                        const pos2 = polyline.positions[i + 1];
                        webMercatorTile2TargetWorld(
                            extents,
                            this.m_decodeInfo,
                            pos1,
                            tmpV3,
                            scaleHeights
                        );
                        worldLine.push(tmpV3.x, tmpV3.y, tmpV3.z);
                        webMercatorTile2TargetWorld(
                            extents,
                            this.m_decodeInfo,
                            pos2,
                            tmpV4,
                            scaleHeights
                        );
                        worldLine.push(tmpV4.x, tmpV4.y, tmpV4.z);

                        if (computeTexCoords) {
                            computeTexCoords(pos1, extents).toArray(lineUvs, lineUvs.length);
                            computeTexCoords(pos2, extents).toArray(lineUvs, lineUvs.length);
                        }
                        if (hasUntiledLines) {
                            // Find where in the [0...1] range relative to the line our current
                            // vertex lies.
                            let offset =
                                this.findRelativePositionInLine(tmpV3, untiledLine) / lineDist;
                            segmentOffsets.push(offset);
                            offset = this.findRelativePositionInLine(tmpV4, untiledLine) / lineDist;
                            segmentOffsets.push(offset);
                        } else {
                            segmentOffsets.push(lastSegmentOffset);

                            // Compute length of segment and whole line to scale down later.
                            const segmentLength = tmpV3.distanceTo(tmpV4);
                            lineLength += segmentLength;
                            lastSegmentOffset += segmentLength;
                            segmentOffsets.push(lastSegmentOffset);
                        }

                        tmpV3.sub(this.m_decodeInfo.center);
                        localLine.push(tmpV3.x, tmpV3.y, tmpV3.z);
                        tmpV4.sub(this.m_decodeInfo.center);
                        localLine.push(tmpV4.x, tmpV4.y, tmpV4.z);

                        localLineSegments!.push(localLine);
                        worldLines.push(worldLine);
                        uvs.push(lineUvs);
                        offsets.push(segmentOffsets);
                    }
                }

                if (!hasUntiledLines && lineLength > 0) {
                    // Scale down each individual segment to range [0..1] for whole line.
                    for (const segOffsets of offsets) {
                        segOffsets.forEach((offs, index) => {
                            segOffsets[index] = offs / lineLength;
                        });
                    }
                }
            }

            // Add continuous lines
            if (hasContinuousLineSegments) {
                const localLine: number[] = [];
                const worldLine: number[] = [];
                const lineUvs: number[] = [];
                const lineOffsets: number[] = [];
                polyline.positions.forEach(pos => {
                    webMercatorTile2TargetWorld(
                        extents,
                        this.m_decodeInfo,
                        pos,
                        tmpV3,
                        scaleHeights
                    );
                    worldLine.push(tmpV3.x, tmpV3.y, tmpV3.z);

                    if (computeTexCoords) {
                        computeTexCoords(pos, extents).toArray(lineUvs, lineUvs.length);
                    }
                    if (hasUntiledLines) {
                        // Find where in the [0...1] range relative to the line our current vertex
                        // lines.
                        const offset =
                            this.findRelativePositionInLine(tmpV3, untiledLine) / lineDist;
                        lineOffsets.push(offset);
                    }
                    tmpV3.sub(this.m_decodeInfo.center);
                    localLine.push(tmpV3.x, tmpV3.y, tmpV3.z);
                });
                localLines.push(localLine);
                worldLines.push(worldLine);
                uvs.push(lineUvs);
                offsets.push(lineOffsets);
            }
        }

        const wantCircle = this.m_decodeInfo.tileKey.level >= 11;

        for (const technique of techniques) {
            if (technique === undefined) {
                continue;
            }
            const techniqueIndex = technique._index;
            const techniqueName = technique.name;

            if (isLineTechnique(technique) || isSolidLineTechnique(technique)) {
                const lineGeometry = isLineTechnique(technique)
                    ? this.m_simpleLines
                    : this.m_solidLines;

                const lineType = isLineTechnique(technique) ? LineType.Simple : LineType.Complex;

                if (hasIndividualLineSegments) {
                    assert(
                        localLineSegments! !== undefined,
                        "OmvDecodedTileEmitter#processLineFeature: " +
                            "Internal error - No localLineSegments"
                    );

                    this.applyLineTechnique(
                        lineGeometry,
                        technique,
                        techniqueIndex,
                        lineType,
                        env.entries,
                        localLineSegments!,
                        context,
                        this.getTextureCoordinateType(technique) ? uvs : undefined,
                        offsets
                    );
                }
                if (localLines.length > 0) {
                    this.applyLineTechnique(
                        lineGeometry,
                        technique,
                        techniqueIndex,
                        lineType,
                        env.entries,
                        localLines,
                        context,
                        this.getTextureCoordinateType(technique) ? uvs : undefined,
                        hasUntiledLines ? offsets : undefined
                    );
                }
            } else if (
                isTextTechnique(technique) ||
                isPoiTechnique(technique) ||
                isLineMarkerTechnique(technique)
            ) {
                const textTechnique = technique as TextTechnique;
                const text = getFeatureText(context, textTechnique, this.m_languages);

                if (text === undefined || text.length === 0) {
                    continue;
                }
                let validLines: number[][] = [];

                if (this.m_skipShortLabels) {
                    // Filter the lines, keep only those that are long enough for labelling. Also,
                    // split jagged label paths to keep processing and rendering only those that
                    // have no sharp corners, which would not be rendered anyway.

                    const worldUnitsPerPixel = tileSizeWorld / this.m_decodeInfo.tileSizeOnScreen;
                    const minEstimatedLabelLength =
                        MIN_AVERAGE_CHAR_WIDTH *
                        text.length *
                        worldUnitsPerPixel *
                        SIZE_ESTIMATION_FACTOR;
                    const minEstimatedLabelLengthSqr =
                        minEstimatedLabelLength * minEstimatedLabelLength;

                    validLines = this.splitJaggyLines(
                        worldLines,
                        minEstimatedLabelLengthSqr,
                        MAX_CORNER_ANGLE
                    );
                } else {
                    validLines = worldLines;
                }

                if (validLines.length === 0) {
                    continue;
                }

                if (isTextTechnique(technique)) {
                    if (text === undefined) {
                        continue;
                    }
                    for (const path of validLines) {
                        const pathLengthSqr = Math2D.computeSquaredLineLength(path);
                        this.m_textPathGeometries.push({
                            technique: techniqueIndex,
                            path,
                            pathLengthSqr,
                            text: String(text),
                            objInfos: this.m_gatherFeatureAttributes
                                ? env.entries
                                : getFeatureId(env.entries)
                        });
                    }
                } else {
                    const lineMarkerTechnique = technique as LineMarkerTechnique;

                    let imageTexture = evaluateTechniqueAttr(
                        context,
                        lineMarkerTechnique.imageTexture
                    );

                    // TODO: `imageTextureField` and `imageTexturePrefix` and `imageTexturePostfix`
                    // are now deprecated

                    // TODO: Move to decoder independent parts of code.
                    if (typeof lineMarkerTechnique.imageTextureField === "string") {
                        const imageTextureValue = env.lookup(lineMarkerTechnique.imageTextureField);
                        imageTexture = imageTextureValue as string;
                        if (typeof lineMarkerTechnique.imageTexturePrefix === "string") {
                            imageTexture = lineMarkerTechnique.imageTexturePrefix + imageTexture;
                        }
                        if (typeof lineMarkerTechnique.imageTexturePostfix === "string") {
                            imageTexture = imageTexture + lineMarkerTechnique.imageTexturePostfix;
                        }
                    }

                    for (const aLine of validLines) {
                        this.m_poiGeometries.push({
                            technique: techniqueIndex,
                            positions: {
                                name: "position",
                                type: "float",
                                buffer: new Float64Array(aLine).buffer,
                                itemCount: 3
                            },
                            texts: [0],
                            stringCatalog: [text, imageTexture],
                            imageTextures: [1],
                            objInfos: this.m_gatherFeatureAttributes
                                ? [env.entries]
                                : [getFeatureId(env.entries)]
                        });
                    }
                }
            } else if (isLabelRejectionLineTechnique(technique)) {
                for (const path of worldLines) {
                    const worldPath: Vector3Like[] = [];
                    for (let i = 0; i < path.length; i += 3) {
                        worldPath.push(new THREE.Vector3().fromArray(path, i) as Vector3Like);
                    }
                    this.m_pathGeometries.push({
                        path: worldPath
                    });
                }
            } else if (isExtrudedLineTechnique(technique)) {
                const meshBuffers = this.findOrCreateMeshBuffers(
                    techniqueIndex,
                    GeometryType.ExtrudedLine
                );
                if (meshBuffers === undefined) {
                    continue;
                }
                const { positions, indices, groups, featureStarts, objInfos } = meshBuffers;
                const start = indices.length;

                const lineWidth = evaluateTechniqueAttr<number>(context, technique.lineWidth);

                if (lineWidth === undefined) {
                    continue;
                }

                const techniqueCaps = evaluateTechniqueAttr<string>(
                    context,
                    technique.caps,
                    "Circle"
                );

                const addCircle = wantCircle && techniqueCaps === "Circle";

                localLines.forEach(aLine => {
                    triangulateLine(aLine, lineWidth, positions, indices, addCircle);
                    featureStarts.push(start);
                    objInfos.push(
                        this.m_gatherFeatureAttributes ? env.entries : getFeatureId(env.entries)
                    );
                });

                const count = indices.length - start;
                groups.push({ start, count, technique: techniqueIndex });
            } else {
                logger.warn(
                    `OmvDecodedTileEmitter#processLineFeature: Invalid line technique
                     ${techniqueName} for layer: ${env.entries.$layer} `
                );
            }
        }
    }

    /**
     * Creates the polygons geometries for the given feature.
     *
     * @param layer - Tile's layer to be processed.
     * @param extents - Tile's layer extents.
     * @param geometry - The current feature containing the main geometry.
     * @param feature - The [[MapEnv]] containing the environment information for the map.
     * @param techniques - The array of [[Technique]] that will be applied to the geometry.
     */
    processPolygonFeature(
        layer: string,
        extents: number,
        geometry: IPolygonGeometry[],
        context: AttrEvaluationContext,
        techniques: IndexedTechnique[]
    ): void {
        const env = context.env;
        this.processFeatureCommon(env);

        const scaleHeights = false; // No need to scale height, source data is 2D.

        techniques.forEach(technique => {
            if (technique === undefined) {
                return;
            }

            const techniqueIndex = technique._index;

            if (techniqueIndex === undefined) {
                throw new Error(
                    "OmvDecodedTileEmitter#processPolygonFeature: " +
                        "Internal error - No technique index"
                );
            }

            let objectBounds: THREE.Box3 | undefined;

            const bbox = env.lookup("bbox");
            if (Array.isArray(bbox)) {
                const [west, south, east, north] = bbox;
                const geoBox = new GeoBox(
                    new GeoCoordinates(south, west),
                    new GeoCoordinates(north, east)
                );
                objectBounds = new THREE.Box3();
                webMercatorProjection.projectBox(geoBox, objectBounds);
            }

            const polygons: Ring[][] = [];

            const isExtruded = isExtrudedPolygonTechnique(technique);
            const isFilled = isFillTechnique(technique);
            const isStandard = isStandardTechnique(technique);

            const isPolygon =
                isExtruded ||
                isFilled ||
                isStandard ||
                (isShaderTechnique(technique) && technique.primitive === "mesh");

            const computeTexCoords = this.getComputeTexCoordsFunc(technique, objectBounds);

            // TODO: CHECK WHY HALF OF THE TILE IS FILTERED OUT.
            const shouldClipPolygons = false; //isPolygon && !isExtruded;

            for (const polygon of geometry) {
                const rings: Ring[] = [];
                for (let i = 0; i < polygon.rings.length; i++) {
                    const isExterior = i === 0;
                    let ringCoords: THREE.Vector2[] = polygon.rings[i];

                    // Disable clipping for the polygon geometries
                    // rendered using the extruded-polygon technique.
                    // We can't clip these polygons for now because
                    // otherwise we could break the current assumptions
                    // used to add oultines around the extruded geometries.
                    if (shouldClipPolygons) {
                        // Quick test to avoid clipping if all the coords
                        // of the current polygon are inside the tile bounds.

                        const hasCoordsOutsideTileBounds = ringCoords.some(
                            p => p.x < 0 || p.x > extents || p.y < 0 || p.y > extents
                        );

                        if (hasCoordsOutsideTileBounds) {
                            ringCoords = clipPolygon(ringCoords, extents);
                        }
                    }

                    const area = THREE.ShapeUtils.area(ringCoords);

                    // According to MVT spec, the rings defining a polygon follow this layout:
                    // [[ext-ring], seq([int-ring])]
                    //
                    // For example:
                    // ┌───────ext1───────┐
                    // │                  │
                    // │  ┌────hole────┐  │
                    // │  │            │  │
                    // │  │            │  │    w:CW     w:CCW
                    // │  │            │  │   [[ext1], [hole]]
                    // │  │            │  │
                    // │  │            │  │
                    // │  │            │  │
                    // │  └──────>─────┘  │
                    // │                  │
                    // └─────────<────────┘
                    // So, if one exterior ring get clipped to a zero-area polygon we
                    // can imply that all the inner rings collapsed as well.
                    // As per spec, all the inner rings must enclosed within the exterior ring.
                    // Using this assumption, we can skip the whole polygon.
                    if (isExterior && area === 0) {
                        break;
                    }

                    // For holes, push the current ring only if it has a non-zero area
                    if (area !== 0) {
                        let textureCoords: THREE.Vector2[] | undefined;

                        if (computeTexCoords !== undefined) {
                            textureCoords = ringCoords.map(coord =>
                                computeTexCoords(coord, extents)
                            );
                        }

                        rings.push(
                            new Ring(ringCoords, textureCoords, extents, shouldClipPolygons)
                        );
                    }
                }

                if (rings.length > 0) {
                    polygons.push(rings);
                }
            }

            const isLine = isSolidLineTechnique(technique) || isLineTechnique(technique);
            if (isPolygon) {
                this.applyPolygonTechnique(polygons, technique, techniqueIndex, context, extents);
            } else if (isLine) {
                const lineGeometry =
                    technique.name === "line" ? this.m_simpleLines : this.m_solidLines;

                const lineType = technique.name === "line" ? LineType.Simple : LineType.Complex;

                // Use individual line segments instead of a continuous line in special cases (round
                // and diamond shaped dashes).
                const needIndividualLineSegments = isSpecialDashesLineTechnique(technique);

                polygons.forEach(rings => {
                    const lines: number[][] = [];
                    const offsets: number[][] | undefined = needIndividualLineSegments
                        ? []
                        : undefined;
                    rings.forEach(ring => {
                        const length = ring.points.length;
                        let line: number[] = [];

                        // Compute length of whole line and offsets of individual segments.
                        let ringLength = 0;
                        let lastSegmentOffset = 0;
                        let segmentOffsets: number[] | undefined = needIndividualLineSegments
                            ? []
                            : undefined;

                        for (let i = 0; i < length; ++i) {
                            if (needIndividualLineSegments && line.length > 0) {
                                // Allocate a line for every segment.
                                line = [];
                                segmentOffsets = [];
                            }

                            const nextIdx = (i + 1) % length;
                            const curr = ring.points[i];
                            const next = ring.points[nextIdx];

                            const properEdge = ring.isProperEdge(i);

                            if (!properEdge && line.length !== 0) {
                                lines.push(line);
                                line = [];
                            } else if (properEdge && line.length === 0) {
                                webMercatorTile2TargetTile(
                                    extents,
                                    this.m_decodeInfo,
                                    tmpV2.copy(curr),
                                    tmpV3,
                                    scaleHeights
                                );
                                line.push(tmpV3.x, tmpV3.y, tmpV3.z);

                                if (needIndividualLineSegments) {
                                    // Add next point as the end point of this line segment.
                                    webMercatorTile2TargetTile(
                                        extents,
                                        this.m_decodeInfo,
                                        tmpV2.copy(next),
                                        tmpV4,
                                        scaleHeights
                                    );
                                    line.push(tmpV4.x, tmpV4.y, tmpV4.z);

                                    segmentOffsets!.push(lastSegmentOffset);

                                    // Compute length of segment and whole line to scale down later.
                                    const segmentLength = tmpV3.distanceTo(tmpV4);
                                    ringLength += segmentLength;
                                    lastSegmentOffset += segmentLength;
                                    segmentOffsets!.push(lastSegmentOffset);
                                }
                            }
                            if (properEdge && !needIndividualLineSegments) {
                                webMercatorTile2TargetTile(
                                    extents,
                                    this.m_decodeInfo,
                                    tmpV2.copy(next),
                                    tmpV3,
                                    scaleHeights
                                );
                                line.push(tmpV3.x, tmpV3.y, tmpV3.z);
                            }

                            if (needIndividualLineSegments && line.length > 0 && ringLength > 0) {
                                // Scale down each individual segment to range [0..1] for the whole
                                // line.
                                segmentOffsets!.forEach((offs, index) => {
                                    segmentOffsets![index] = offs / ringLength;
                                });

                                // Close the line segment as a single line.
                                lines.push(line);
                                offsets!.push(segmentOffsets!);
                            }
                        }

                        if (!needIndividualLineSegments && line.length > 0) {
                            lines.push(line);
                        }
                    });

                    if (lines.length === 0) {
                        return;
                    }

                    this.applyLineTechnique(
                        lineGeometry,
                        technique,
                        techniqueIndex,
                        lineType,
                        env.entries,
                        lines,
                        context,
                        undefined,
                        offsets!
                    );
                });
            }
        });
    }

    /**
     * Creates the geometries that belongs to the [[Tile].
     *
     * @returns The [[DecodedTile]]
     */
    getDecodedTile(): DecodedTile {
        this.createGeometries();
        this.processSimpleLines(this.m_simpleLines);
        this.processLines(this.m_solidLines);

        const decodedTile: DecodedTile = {
            techniques: this.m_styleSetEvaluator.decodedTechniques,
            geometries: this.m_geometries,
            decodeTime: undefined
        };
        if (this.m_textGeometries.length > 0) {
            decodedTile.textGeometries = this.m_textGeometries;
        }
        if (this.m_poiGeometries.length > 0) {
            decodedTile.poiGeometries = this.m_poiGeometries;
        }
        if (this.m_textPathGeometries.length > 0) {
            decodedTile.textPathGeometries = this.m_textPathGeometries;
        }
        if (this.m_pathGeometries.length > 0) {
            decodedTile.pathGeometries = this.m_pathGeometries;
        }
        if (this.m_sources.length !== 0) {
            decodedTile.copyrightHolderIds = this.m_sources;
        }
        decodedTile.maxGeometryHeight = this.m_maxGeometryHeight;
        decodedTile.minGeometryHeight = this.m_minGeometryHeight;
        return decodedTile;
    }

    /**
     * Split the lines array into multiple parts if there are sharp corners. Reject parts that are
     * too short to display the label text.
     *
     * @param {number[][]} lines Array containing the points of the paths.
     * @param {number} minEstimatedLabelLengthSqr Minimum label size squared.
     * @param {number} maxCornerAngle Maximum angle between consecutive path segments in radians.
     * @returns The split and filtered lines array.
     */
    protected splitJaggyLines(
        lines: number[][],
        minEstimatedLabelLengthSqr: number,
        maxCornerAngle: number
    ): number[][] {
        const validLines: number[][] = [];

        const computeBoundingBoxSizeSqr = (
            aLine: number[],
            startIndex: number,
            endIndex: number
        ): number => {
            let minX = Number.MAX_SAFE_INTEGER;
            let maxX = Number.MIN_SAFE_INTEGER;
            let minY = Number.MAX_SAFE_INTEGER;
            let maxY = Number.MIN_SAFE_INTEGER;
            for (let i = startIndex; i < endIndex; i += 3) {
                const x = aLine[i];
                const y = aLine[i + 1];
                if (x < minX) {
                    minX = x;
                }
                if (x > maxX) {
                    maxX = x;
                }
                if (y < minY) {
                    minY = y;
                }
                if (y > maxY) {
                    maxY = y;
                }
            }

            return (maxX - minX) * (maxX - minX) + (maxY - minY) * (maxY - minY);
        };

        // Work on a copy of the path.
        const pathsToCheck = lines.slice();

        while (pathsToCheck.length > 0) {
            const path = pathsToCheck.pop();

            if (path === undefined || path.length < 6) {
                continue;
            }

            let splitIndex = -1;

            for (let i = 0; i < path.length - 3; i += 3) {
                tempP0.set(path[i], path[i + 1]);
                tempP1.set(path[i + 3], path[i + 4]);
                const tangent = tempP1.sub(tempP0).normalize();

                if (i > 0) {
                    const theta = Math.atan2(
                        tempPreviousTangent.x * tangent.y - tangent.x * tempPreviousTangent.y,
                        tangent.dot(tempPreviousTangent)
                    );

                    if (Math.abs(theta) > maxCornerAngle) {
                        splitIndex = i;
                        break;
                    }
                }
                tempPreviousTangent.set(tangent.x, tangent.y);
            }

            if (splitIndex > 0) {
                // Estimate if the first part of the path is long enough for the label.
                const firstPathLengthSqr = computeBoundingBoxSizeSqr(path, 0, splitIndex + 3);
                // Estimate if the second part of the path is long enough for the label.
                const secondPathLengthSqr = computeBoundingBoxSizeSqr(
                    path,
                    splitIndex,
                    path.length
                );

                if (firstPathLengthSqr > minEstimatedLabelLengthSqr) {
                    // Split off the valid first path points with a clone of the path.
                    validLines.push(path.slice(0, splitIndex + 3));
                }

                if (secondPathLengthSqr > minEstimatedLabelLengthSqr) {
                    // Now process the second part of the path, it may have to be split
                    // again.
                    pathsToCheck.push(path.slice(splitIndex));
                }
            } else {
                // Estimate if the path is long enough for the label, otherwise ignore
                // it for rendering text. First, compute the bounding box in world
                // coordinates.
                const pathLengthSqr = computeBoundingBoxSizeSqr(path, 0, path.length);

                if (pathLengthSqr > minEstimatedLabelLengthSqr) {
                    validLines.push(path);
                }
            }
        }

        return validLines;
    }

    private getTextureCoordinateType(technique: Technique): TextureCoordinateType | undefined {
        // Set TileSpace coordinate type to generate texture coordinates for the displacement map
        // used in elevation overlay.
        if (
            (isFillTechnique(technique) ||
                isSolidLineTechnique(technique) ||
                isExtrudedPolygonTechnique(technique)) &&
            this.m_enableElevationOverlay
        ) {
            return TextureCoordinateType.TileSpace;
        }

        return textureCoordinateType(technique);
    }

    private getComputeTexCoordsFunc(
        technique: Technique,
        objectBounds?: THREE.Box3
    ): TexCoordsFunction | undefined {
        const texCoordType = this.getTextureCoordinateType(technique);

        switch (texCoordType) {
            case TextureCoordinateType.TileSpace:
                return (tilePos: THREE.Vector2, tileExtents: number): THREE.Vector2 => {
                    const uv = tilePos.clone().divideScalar(tileExtents);
                    uv.y = 1 - uv.y;
                    return uv;
                };

            case TextureCoordinateType.EquirectangularSpace:
                return (tilePos: THREE.Vector2, extents: number): THREE.Vector2 => {
                    const worldPos = tile2world(extents, this.m_decodeInfo, tilePos, false, tmpV3r);
                    const uv = normalizedEquirectangularProjection.reprojectPoint(
                        webMercatorProjection,
                        worldPos
                    );
                    return new THREE.Vector2(uv.x, uv.y);
                };

            case TextureCoordinateType.FeatureSpace:
                if (!objectBounds) {
                    return undefined;
                }
                return (tilePos: THREE.Vector2, extents: number): THREE.Vector2 => {
                    const worldPos = tile2world(extents, this.m_decodeInfo, tilePos, false, tmpV3r);
                    const uv = new THREE.Vector2(worldPos.x, worldPos.y);
                    if (objectBounds) {
                        uv.x -= objectBounds.min.x;
                        uv.y -= objectBounds.min.y;
                        uv.x /= objectBounds.max.x - objectBounds.min.x;
                        uv.y /= objectBounds.max.y - objectBounds.min.y;
                    }
                    uv.y = 1 - uv.y;
                    return uv;
                };

            default:
                return undefined;
        }
    }

    private applyLineTechnique(
        linesGeometry: LinesGeometry[],
        technique: IndexedTechnique,
        techniqueIndex: number,
        lineType = LineType.Complex,
        featureAttributes: AttributeMap,
        lines: number[][],
        context: AttrEvaluationContext,
        uvs?: number[][],
        offsets?: number[][]
    ): void {
        let lineGroup: LineGroup;
        const lineGroupGeometries = linesGeometry.find(aLine => aLine.technique === techniqueIndex);
        const hasNormalsAndUvs = uvs !== undefined;
        if (lineGroupGeometries === undefined) {
            lineGroup = new LineGroup(hasNormalsAndUvs, undefined, lineType === LineType.Simple);
            const aLine: LinesGeometry = {
                type: lineType === LineType.Complex ? GeometryType.SolidLine : GeometryType.Line,
                technique: techniqueIndex,
                lines: lineGroup
            };

            if (this.m_gatherFeatureAttributes) {
                aLine.objInfos = [featureAttributes];
                aLine.featureStarts = [0];
            }

            linesGeometry.push(aLine);
        } else {
            lineGroup = lineGroupGeometries.lines;

            if (
                this.m_gatherFeatureAttributes &&
                lineGroupGeometries.objInfos &&
                lineGroupGeometries.featureStarts
            ) {
                // Add ID to tag the geometry, also provide the current length of the index
                // attribute
                lineGroupGeometries.objInfos.push(featureAttributes);
                lineGroupGeometries.featureStarts.push(lineGroup.indices.length);
            }
        }
        let i = 0;
        lines.forEach(aLine => {
            lineGroup.add(
                this.m_decodeInfo.center,
                aLine,
                this.projection,
                offsets ? offsets[i] : undefined,
                uvs ? uvs[i] : undefined
            );
            i++;
        });
    }

    private applyPolygonTechnique(
        polygons: Ring[][],
        technique: Technique,
        techniqueIndex: number,
        context: AttrEvaluationContext,
        extents: number
    ): void {
        if (polygons.length === 0) {
            return;
        }

        const isExtruded = isExtrudedPolygonTechnique(technique);

        const geometryType = isExtruded ? GeometryType.ExtrudedPolygon : GeometryType.Polygon;
        const meshBuffers = this.findOrCreateMeshBuffers(techniqueIndex, geometryType);

        if (meshBuffers === undefined) {
            return;
        }

        const extrudedPolygonTechnique = technique as ExtrudedPolygonTechnique;
        const fillTechnique = technique as FillTechnique;
        const boundaryWalls = extrudedPolygonTechnique.boundaryWalls === true;

        const isFilled = isFillTechnique(technique);
        const texCoordType = this.getTextureCoordinateType(technique);

        let height = evaluateTechniqueAttr<number>(context, extrudedPolygonTechnique.height);

        let floorHeight = evaluateTechniqueAttr<number>(
            context,
            extrudedPolygonTechnique.floorHeight
        );

        if (height === undefined) {
            // Get the height values for the footprint and extrusion.
            const featureHeight = context.env.lookup("height") as number;
            const styleSetDefaultHeight = evaluateTechniqueAttr<number>(
                context,
                extrudedPolygonTechnique.defaultHeight
            );
            height =
                featureHeight !== undefined
                    ? featureHeight
                    : styleSetDefaultHeight !== undefined
                    ? styleSetDefaultHeight
                    : 0;
        }

        if (floorHeight === undefined) {
            const featureMinHeight = context.env.lookup("min_height") as number;
            floorHeight = featureMinHeight !== undefined && !isFilled ? featureMinHeight : 0;
        }

        // Prevent that extruded buildings are completely flat (can introduce errors in normal
        // computation and extrusion).
        height = Math.max(floorHeight + ExtrusionFeatureDefs.MIN_BUILDING_HEIGHT, height);

        const tileLevel = this.m_decodeInfo.tileKey.level;

        const scaleHeights =
            isExtruded && scaleHeight(context, extrudedPolygonTechnique, tileLevel);

        this.m_decodeInfo.tileBounds.getCenter(tempTileOrigin);

        const {
            positions,
            normals,
            textureCoordinates,
            colors,
            extrusionAxis,
            indices,
            edgeIndices,
            groups
        } = meshBuffers;

        const isSpherical = this.m_decodeInfo.targetProjection.type === ProjectionType.Spherical;

        const edgeWidth = isExtruded
            ? extrudedPolygonTechnique.lineWidth ?? 0.0
            : isFilled
            ? fillTechnique.lineWidth ?? 0.0
            : 0.0;
        const hasEdges = typeof edgeWidth === "number" ? edgeWidth > 0.0 : true;

        let color: THREE.Color | undefined;
        if (isExtrudedPolygonTechnique(technique)) {
            if (getOptionValue(technique.vertexColors, false)) {
                let colorValue = evaluateTechniqueAttr<StyleColor>(context, technique.color);
                if (colorValue === undefined) {
                    const featureColor = context.env.lookup("color");
                    if (this.isColorStringValid(featureColor)) {
                        colorValue = String(featureColor);
                    }
                }
                if (colorValue === undefined) {
                    colorValue = evaluateTechniqueAttr<number | string>(
                        context,
                        technique.defaultColor,
                        0x000000
                    );
                }

                if (colorValue === undefined) {
                    colorValue = 0x000000;
                }
                tmpColor.set(colorValue as any);

                color = tmpColor;
            }
        }

        for (const polygon of polygons) {
            const startIndexCount = indices.length;
            const edgeStartIndexCount = edgeIndices.length;

            // Iterate over the exterior ring of the current polygon
            const vertices: number[] = [];
            const polygonBaseVertex = positions.length / 3;
            const exteriorRing = polygon[0];

            const featureStride = exteriorRing.vertexStride;
            const vertexStride = featureStride + 2;

            // The exterior ring is always the first
            for (let i = 0; i < exteriorRing.points.length; ++i) {
                const point = exteriorRing.points[i];

                // Invert the Y component to preserve the correct winding without transforming
                // from webMercator's local to global space.
                vertices.push(point.x, -point.y);

                if (exteriorRing.textureCoords !== undefined) {
                    vertices.push(exteriorRing.textureCoords[i].x, exteriorRing.textureCoords[i].y);
                }

                const nextIdx = (i + 1) % exteriorRing.points.length;

                const properEdge = exteriorRing.isProperEdge(i);

                // Calculate nextEdge and nextWall.
                vertices.push(
                    properEdge ? nextIdx : -1,
                    boundaryWalls || properEdge ? nextIdx : -1
                );
            }

            // Iterate over the inner rings - if any
            const holes: number[] = [];
            let ringIndex = 1;
            while (ringIndex < polygon.length) {
                const vertexOffset = vertices.length / vertexStride;
                holes.push(vertexOffset);

                const hole = polygon[ringIndex++];
                for (let i = 0; i < hole.points.length; ++i) {
                    const nextIdx = (i + 1) % hole.points.length;
                    const point = hole.points[i];

                    // Invert the Y component to preserve the correct winding without
                    // transforming from webMercator's local to global space.
                    vertices.push(point.x, -point.y);

                    if (hole.textureCoords !== undefined) {
                        vertices.push(hole.textureCoords[i].x, hole.textureCoords[i].y);
                    }

                    // Calculate nextEdge and nextWall.
                    const insideExtents = hole.isProperEdge(i);

                    vertices.push(
                        insideExtents ? vertexOffset + nextIdx : -1,
                        boundaryWalls || insideExtents ? vertexOffset + nextIdx : -1
                    );
                }
            }

            try {
                // Triangulate the footprint polyline.
                const triangles = earcut(vertices, holes, vertexStride);
                const originalVertexCount = vertices.length / vertexStride;

                // Subdivide for spherical projections if needed.
                if (isSpherical) {
                    const geom = new THREE.BufferGeometry();

                    const positionArray = [];
                    const uvArray = [];
                    const edgeArray = [];
                    const wallArray = [];

                    // Transform to global webMercator coordinates to be able to reproject to
                    // sphere.
                    for (let i = 0; i < vertices.length; i += vertexStride) {
                        const worldPos = tile2world(
                            extents,
                            this.m_decodeInfo,
                            tmpV2.set(vertices[i], vertices[i + 1]),
                            true,
                            tmpV3r
                        );
                        positionArray.push(worldPos.x, worldPos.y, 0);
                        if (texCoordType !== undefined) {
                            uvArray.push(vertices[i + 2], vertices[i + 3]);
                        }
                        edgeArray.push(vertices[i + featureStride]);
                        wallArray.push(vertices[i + featureStride + 1]);
                    }

                    // Create the temporary geometry used for subdivision.
                    const posAttr = new THREE.BufferAttribute(new Float32Array(positionArray), 3);
                    geom.setAttribute("position", posAttr);
                    let uvAttr: THREE.BufferAttribute | undefined;
                    if (texCoordType !== undefined) {
                        uvAttr = new THREE.BufferAttribute(new Float32Array(uvArray), 2);
                        geom.setAttribute("uv", uvAttr);
                    }
                    const edgeAttr = new THREE.BufferAttribute(new Float32Array(edgeArray), 1);
                    geom.setAttribute("edge", edgeAttr);
                    const wallAttr = new THREE.BufferAttribute(new Float32Array(wallArray), 1);
                    geom.setAttribute("wall", edgeAttr);
                    const index = createIndexBufferAttribute(triangles, posAttr.count - 1);
                    const indexAttr =
                        index.type === "uint32"
                            ? new THREE.Uint32BufferAttribute(index.buffer, 1)
                            : new THREE.Uint16BufferAttribute(index.buffer, 1);
                    geom.setIndex(indexAttr);

                    // Increase tesselation of polygons for certain zoom levels
                    // to remove mixed LOD cracks
                    const zoomLevel = this.m_decodeInfo.tileKey.level;
                    if (zoomLevel >= 3 && zoomLevel < 9) {
                        const subdivision = Math.pow(2, 9 - zoomLevel);
                        const { geoBox } = this.m_decodeInfo;
                        const edgeModifier = new EdgeLengthGeometrySubdivisionModifier(
                            subdivision,
                            geoBox,
                            SubdivisionMode.NoDiagonals,
                            webMercatorProjection
                        );
                        edgeModifier.modify(geom);
                    }

                    // FIXME(HARP-5700): Subdivision modifier ignores texture coordinates.
                    const modifier = new SphericalGeometrySubdivisionModifier(
                        THREE.MathUtils.degToRad(10),
                        webMercatorProjection
                    );
                    modifier.modify(geom);

                    // Reassemble the vertex buffer, transforming the subdivided global
                    // webMercator points back to local space.
                    vertices.length = 0;
                    triangles.length = 0;
                    for (let i = 0; i < posAttr.array.length; i += 3) {
                        const tilePos = world2tile(
                            extents,
                            this.m_decodeInfo,
                            tmpV3.set(posAttr.array[i], posAttr.array[i + 1], 0),
                            true,
                            tmpV2r
                        );
                        vertices.push(tilePos.x, tilePos.y);
                        if (texCoordType !== undefined) {
                            vertices.push(uvAttr!.array[(i / 3) * 2]);
                            vertices.push(uvAttr!.array[(i / 3) * 2 + 1]);
                        }
                        vertices.push(edgeAttr.array[i / 3]);
                        vertices.push(wallAttr.array[i / 3]);
                    }

                    const geomIndex = geom.getIndex();
                    if (geomIndex !== null) {
                        triangles.push(...(geomIndex.array as Float32Array));
                    }
                }

                // Add the footprint/roof vertices to the position buffer.
                tempVertNormal.set(0, 0, 1);

                // Assemble the vertex buffer.
                for (let i = 0; i < vertices.length; i += vertexStride) {
                    webMercatorTile2TargetWorld(
                        extents,
                        this.m_decodeInfo,
                        tmpV2.set(vertices[i], vertices[i + 1]),
                        tmpV3,
                        false, // no need to scale height (source data is 2D).
                        true
                    );

                    const scaleFactor = scaleHeights
                        ? this.m_decodeInfo.targetProjection.getScaleFactor(tmpV3)
                        : 1.0;
                    this.m_maxGeometryHeight = Math.max(
                        this.m_maxGeometryHeight,
                        scaleFactor * height
                    );
                    this.m_minGeometryHeight = Math.min(
                        this.m_minGeometryHeight,
                        scaleFactor * height
                    );

                    if (isSpherical) {
                        tempVertNormal.set(tmpV3.x, tmpV3.y, tmpV3.z).normalize();
                    }
                    tmpV3.sub(this.center);

                    tempFootDisp.copy(tempVertNormal).multiplyScalar(floorHeight * scaleFactor);
                    positions.push(
                        tmpV3.x + tempFootDisp.x,
                        tmpV3.y + tempFootDisp.y,
                        tmpV3.z + tempFootDisp.z
                    );
                    if (texCoordType !== undefined) {
                        textureCoordinates.push(vertices[i + 2], vertices[i + 3]);
                    }
                    if (this.m_enableElevationOverlay) {
                        normals.push(...tempVertNormal.toArray());
                    }
                    if (isExtruded) {
                        tempRoofDisp.copy(tempVertNormal).multiplyScalar(height * scaleFactor);
                        positions.push(
                            tmpV3.x + tempRoofDisp.x,
                            tmpV3.y + tempRoofDisp.y,
                            tmpV3.z + tempRoofDisp.z
                        );
                        extrusionAxis.push(
                            0.0,
                            0.0,
                            0.0,
                            0.0,
                            tempRoofDisp.x - tempFootDisp.x,
                            tempRoofDisp.y - tempFootDisp.y,
                            tempRoofDisp.z - tempFootDisp.z,
                            1.0
                        );
                        if (texCoordType !== undefined) {
                            textureCoordinates.push(vertices[i + 2], vertices[i + 3]);
                        }
                        if (this.m_enableElevationOverlay) {
                            normals.push(...tempVertNormal.toArray());
                        }
                        if (color !== undefined) {
                            colors.push(color.r, color.g, color.b, color.r, color.g, color.b);
                        }
                    }
                }

                // Add the footprint/roof indices to the index buffer.
                for (let i = 0; i < triangles.length; i += 3) {
                    if (isExtruded) {
                        // When extruding we duplicate the vertices, so that all even vertices
                        // belong to the bottom and all odd vertices belong to the top.
                        const i0 = polygonBaseVertex + triangles[i + 0] * 2 + 1;
                        const i1 = polygonBaseVertex + triangles[i + 1] * 2 + 1;
                        const i2 = polygonBaseVertex + triangles[i + 2] * 2 + 1;
                        indices.push(i0, i1, i2);
                    } else {
                        const i0 = polygonBaseVertex + triangles[i + 0];
                        const i1 = polygonBaseVertex + triangles[i + 1];
                        const i2 = polygonBaseVertex + triangles[i + 2];
                        indices.push(i0, i1, i2);
                    }
                }

                // Assemble the index buffer for edges (follow vertices as linked list).
                if (hasEdges) {
                    this.addEdges(
                        polygonBaseVertex,
                        originalVertexCount,
                        vertexStride,
                        featureStride,
                        positions,
                        vertices,
                        edgeIndices,
                        isExtruded,
                        extrudedPolygonTechnique.footprint,
                        extrudedPolygonTechnique.maxSlope
                    );
                }
                if (isExtruded) {
                    this.addWalls(
                        polygonBaseVertex,
                        originalVertexCount,
                        vertexStride,
                        featureStride,
                        vertices,
                        indices
                    );
                }
            } catch (err) {
                logger.error(`cannot triangulate geometry`, err);
            }

            if (this.m_gatherFeatureAttributes) {
                meshBuffers.objInfos.push(context.env.entries);
                meshBuffers.featureStarts.push(startIndexCount);
                meshBuffers.edgeFeatureStarts.push(edgeStartIndexCount);
            }

            const count = indices.length - startIndexCount;
            if (count > 0) {
                groups.push({
                    start: startIndexCount,
                    count,
                    technique: techniqueIndex
                });
            }
        }
    }

    private createGeometries() {
        this.m_meshBuffers.forEach((meshBuffers, techniqueIdx) => {
            if (meshBuffers.positions.length === 0) {
                return;
            } // nothing to do

            if (
                !this.m_styleSetEvaluator.techniques ||
                this.m_styleSetEvaluator.techniques.length <= techniqueIdx
            ) {
                throw new Error("Invalid technique index");
            }

            const technique = this.m_styleSetEvaluator.techniques[techniqueIdx];
            if (technique === undefined) {
                return;
            }
            if (meshBuffers.texts.length > 0) {
                const geometry: TextGeometry = {
                    positions: {
                        name: "position",
                        type: "float",
                        buffer: new Float64Array(meshBuffers.positions).buffer,
                        itemCount: 3
                    },
                    texts: meshBuffers.texts,
                    technique: techniqueIdx,
                    stringCatalog: meshBuffers.stringCatalog,
                    objInfos: meshBuffers.objInfos
                };

                if (isTextTechnique(technique)) {
                    this.m_textGeometries.push(geometry);
                } else {
                    assert(isPoiTechnique(technique));
                    const poiGeometry = geometry as PoiGeometry;
                    poiGeometry.imageTextures = meshBuffers.imageTextures;
                    poiGeometry.offsetDirections = meshBuffers.offsetDirections;
                    this.m_poiGeometries.push(poiGeometry);
                }
                return;
            }

            const positionElements = new Float32Array(meshBuffers.positions);

            if (meshBuffers.groups.length === 0) {
                // create a default group containing all the vertices in the position attribute.

                meshBuffers.groups.push({
                    start: 0,
                    count: positionElements.length / 3,
                    technique: techniqueIdx
                });
            }

            const vertexAttributes: BufferAttribute[] = [
                {
                    name: "position",
                    buffer: positionElements.buffer,
                    itemCount: 3,
                    type: "float"
                }
            ];

            const geometry: Geometry = {
                type: meshBuffers.type,
                vertexAttributes,
                groups: meshBuffers.groups
            };

            if (meshBuffers.normals.length > 0) {
                const normals = new Float32Array(meshBuffers.normals);
                assert(
                    normals.length === positionElements.length,
                    "length of normals buffer is different than the length of the " +
                        "position buffer"
                );

                vertexAttributes.push({
                    name: "normal",
                    buffer: normals.buffer,
                    itemCount: 3,
                    type: "float"
                });
            }

            if (meshBuffers.colors.length > 0) {
                const colors = new Float32Array(meshBuffers.colors);
                assert(
                    colors.length === positionElements.length,
                    "length of colors buffer is different than the length of the " +
                        "position buffer"
                );

                vertexAttributes.push({
                    name: "color",
                    buffer: colors.buffer,
                    itemCount: 3,
                    type: "float"
                });
            }

            const positionCount = meshBuffers.positions.length / 3;

            if (meshBuffers.textureCoordinates.length > 0) {
                const texCoordCount = meshBuffers.textureCoordinates.length / 2;
                assert(
                    texCoordCount === positionCount,
                    "length of textureCoordinates buffer is different than the length of the" +
                        "position buffer"
                );

                const textureCoordinates = new Float32Array(meshBuffers.textureCoordinates);
                vertexAttributes.push({
                    name: "uv",
                    buffer: textureCoordinates.buffer as ArrayBuffer,
                    itemCount: 2,
                    type: "float"
                });
            }

            if (meshBuffers.extrusionAxis.length > 0) {
                const extrusionAxis = new Float32Array(meshBuffers.extrusionAxis);
                assert(
                    extrusionAxis.length / 4 === positionElements.length / 3,
                    "length of extrusionAxis buffer is different than the length of the " +
                        "position buffer"
                );

                vertexAttributes.push({
                    name: "extrusionAxis",
                    buffer: extrusionAxis.buffer as ArrayBuffer,
                    itemCount: 4,
                    type: "float"
                });
            }

            if (meshBuffers.indices.length > 0) {
                geometry.index = createIndexBufferAttribute(meshBuffers.indices, positionCount - 1);
            }

            if (meshBuffers.edgeIndices.length > 0) {
                geometry.edgeIndex = createIndexBufferAttribute(
                    meshBuffers.edgeIndices,
                    positionCount - 1,
                    "edgeIndex"
                );
            }

            geometry.featureStarts = meshBuffers.featureStarts;
            geometry.edgeFeatureStarts = meshBuffers.edgeFeatureStarts;
            geometry.objInfos = meshBuffers.objInfos;

            this.m_geometries.push(geometry);
        });
    }

    private processLines(linesArray: LinesGeometry[]) {
        linesArray.forEach(linesGeometry => {
            const { vertices, indices } = linesGeometry.lines;
            const technique = linesGeometry.technique;
            const buffer = new Float32Array(vertices).buffer as ArrayBuffer;
            const index = createIndexBufferAttribute(
                indices,
                vertices.length / linesGeometry.lines.stride - 1
            );
            const attr: InterleavedBufferAttribute = {
                type: "float",
                stride: linesGeometry.lines.stride,
                buffer,
                attributes: linesGeometry.lines.vertexAttributes
            };
            const geometry: Geometry = {
                type: GeometryType.SolidLine,
                index,
                interleavedVertexAttributes: [attr],
                groups: [{ start: 0, count: indices.length, technique }],
                vertexAttributes: [],
                featureStarts: linesGeometry.featureStarts,
                objInfos: linesGeometry.objInfos
            };

            this.m_geometries.push(geometry);
        });
    }

    private processSimpleLines(linesArray: LinesGeometry[]) {
        linesArray.forEach(linesGeometry => {
            const { vertices, indices } = linesGeometry.lines;
            const technique = linesGeometry.technique;
            const buffer = new Float32Array(vertices).buffer as ArrayBuffer;
            const attr: BufferAttribute = {
                buffer,
                itemCount: 3,
                type: "float",
                name: "position"
            };
            const geometry: Geometry = {
                type: GeometryType.Line,
                index: createIndexBufferAttribute(indices, vertices.length / attr.itemCount - 1),
                vertexAttributes: [attr],
                groups: [{ start: 0, count: indices.length, technique }],
                featureStarts: linesGeometry.featureStarts,
                objInfos: linesGeometry.objInfos
            };

            this.m_geometries.push(geometry);
        });
    }

    private findOrCreateMeshBuffers(index: number, type: GeometryType): MeshBuffers | undefined {
        let buffers = this.m_meshBuffers.get(index);

        if (buffers !== undefined) {
            if (buffers.type !== type) {
                logger.error(`MeshBuffer has been created with wrong type "${GeometryType[type]}"
                instead of "${GeometryType[buffers.type]}"`);
                return undefined;
            }
            return buffers;
        }
        buffers = new MeshBuffers(type);
        this.m_meshBuffers.set(index, buffers);
        return buffers;
    }

    private processFeatureCommon(env: Env) {
        const source = env.lookup("source");
        if (typeof source === "string" && source !== "") {
            if (!this.m_sources.includes(source)) {
                this.m_sources.push(source);
            }
        }
    }

    private isColorStringValid(color: Value | undefined): color is string {
        return typeof color === "string" && color.length > 0;
    }

    private addEdges(
        featureBaseVertex: number,
        featureVertexCount: number,
        vertexStride: number,
        featureStride: number,
        positions: number[],
        vertices: number[],
        indices: number[],
        isExtruded: boolean,
        hasFootprint?: boolean,
        maxSlope?: number
    ) {
        const tmpEdgeA = new THREE.Vector3();
        const tmpEdgeB = new THREE.Vector3();
        let firstRingVertex: number | undefined;
        let prevRingVertex: number | undefined;
        let currRingVertex = 0;
        let maxRingVertex = 0;

        while (currRingVertex < featureVertexCount) {
            while (currRingVertex !== firstRingVertex) {
                if (firstRingVertex === undefined) {
                    firstRingVertex = currRingVertex;
                }
                if (currRingVertex < featureVertexCount) {
                    maxRingVertex = Math.max(maxRingVertex, currRingVertex);
                }

                const nextRingVertex = vertices[currRingVertex * vertexStride + featureStride];
                if (nextRingVertex < 0) {
                    break;
                } else {
                    if (!isExtruded) {
                        indices.push(
                            featureBaseVertex + currRingVertex,
                            featureBaseVertex + nextRingVertex
                        );
                    } else {
                        if (hasFootprint === true) {
                            indices.push(
                                featureBaseVertex + currRingVertex * 2,
                                featureBaseVertex + nextRingVertex * 2
                            );
                        }
                        indices.push(
                            featureBaseVertex + currRingVertex * 2 + 1,
                            featureBaseVertex + nextRingVertex * 2 + 1
                        );

                        if (maxSlope !== undefined) {
                            if (prevRingVertex !== undefined) {
                                const prevPos = (featureBaseVertex + prevRingVertex * 2) * 3;
                                const currPos = (featureBaseVertex + currRingVertex * 2) * 3;
                                const nextPos = (featureBaseVertex + nextRingVertex * 2) * 3;
                                tmpEdgeA
                                    .set(
                                        positions[currPos] - positions[prevPos],
                                        positions[currPos + 1] - positions[prevPos + 1],
                                        positions[currPos + 2] - positions[prevPos + 2]
                                    )
                                    .normalize();
                                tmpEdgeB
                                    .set(
                                        positions[nextPos] - positions[currPos],
                                        positions[nextPos + 1] - positions[currPos + 1],
                                        positions[nextPos + 2] - positions[currPos + 2]
                                    )
                                    .normalize();
                                if (tmpEdgeA.dot(tmpEdgeB) <= maxSlope) {
                                    indices.push(
                                        featureBaseVertex + currRingVertex * 2,
                                        featureBaseVertex + currRingVertex * 2 + 1
                                    );
                                }
                            }
                        } else {
                            indices.push(
                                featureBaseVertex + currRingVertex * 2,
                                featureBaseVertex + currRingVertex * 2 + 1
                            );
                        }
                    }
                    prevRingVertex = currRingVertex;
                    currRingVertex = nextRingVertex;
                }
            }
            currRingVertex = maxRingVertex + 1;
            firstRingVertex = undefined;
            prevRingVertex = undefined;
        }
    }

    private addWalls(
        featureBaseVertex: number,
        featureVertexCount: number,
        vertexStride: number,
        featureStride: number,
        vertices: number[],
        indices: number[]
    ) {
        let firstRingVertex: number | undefined;
        let currRingVertex = 0;
        let maxRingVertex = 0;

        while (currRingVertex < featureVertexCount) {
            while (currRingVertex !== firstRingVertex) {
                if (firstRingVertex === undefined) {
                    firstRingVertex = currRingVertex;
                }
                if (currRingVertex < featureVertexCount) {
                    maxRingVertex = Math.max(maxRingVertex, currRingVertex);
                }

                const nextRingVertex = vertices[currRingVertex * vertexStride + featureStride + 1];
                if (nextRingVertex < 0) {
                    break;
                } else {
                    indices.push(
                        featureBaseVertex + currRingVertex * 2,
                        featureBaseVertex + currRingVertex * 2 + 1,
                        featureBaseVertex + nextRingVertex * 2 + 1,
                        featureBaseVertex + nextRingVertex * 2 + 1,
                        featureBaseVertex + nextRingVertex * 2,
                        featureBaseVertex + currRingVertex * 2
                    );
                }
                currRingVertex = nextRingVertex;
            }
            currRingVertex = maxRingVertex + 1;
            firstRingVertex = undefined;
        }
    }

    private findRelativePositionInLine(p: THREE.Vector3, line: number[]): number {
        let lineDist = Infinity;
        let lineOffset = 0;
        for (let i = 0; i < line.length; i += 4) {
            // Find the closest point C in segment AB to point P.
            tmpLine.set(
                tmpPointA.set(line[i], line[i + 1], line[i + 2]),
                tmpPointB.set(line[i + 4], line[i + 5], line[i + 6])
            );
            tmpLine.closestPointToPoint(p, true, tmpPointC);

            // If P is in AB (or really close), save A as anchor point and C (to estimate distance
            // from segment origin).
            const dist = tmpPointC.distanceTo(p);
            if (dist < lineDist) {
                tmpPointD.copy(tmpPointC);
                tmpPointE.copy(tmpPointA);
                lineDist = dist;
                lineOffset = line[i + 3];
            }
        }
        // Return the relative position of P inside the line.
        return lineOffset + tmpPointD.distanceTo(tmpPointE);
    }
}
