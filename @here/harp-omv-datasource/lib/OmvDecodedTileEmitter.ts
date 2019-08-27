/*
 * Copyright (C) 2017-2019 HERE Europe B.V.
 * Licensed under Apache 2.0, see full license in LICENSE
 * SPDX-License-Identifier: Apache-2.0
 */

import {
    BufferAttribute,
    composeTechniqueTextureName,
    DecodedTile,
    ExtrudedPolygonTechnique,
    FillTechnique,
    Geometry,
    GeometryType,
    getPropertyValue,
    Group,
    IndexedTechnique,
    InterleavedBufferAttribute,
    isDashedLineTechnique,
    isExtrudedLineTechnique,
    isExtrudedPolygonTechnique,
    isFillTechnique,
    isLineMarkerTechnique,
    isLineTechnique,
    isPoiTechnique,
    isSolidLineTechnique,
    isStandardTechnique,
    isTextTechnique,
    LineMarkerTechnique,
    PoiGeometry,
    PoiTechnique,
    Technique,
    TextGeometry,
    TextPathGeometry,
    TextTechnique,
    textureCoordinateType,
    TextureCoordinateType
} from "@here/harp-datasource-protocol";
import {
    IMeshBuffers,
    MapEnv,
    StyleSetEvaluator,
    Value
} from "@here/harp-datasource-protocol/index-decoder";
import { LineGroup } from "@here/harp-lines/lib/Lines";
import { triangulateLine } from "@here/harp-lines/lib/TriangulateLines";
import { assert, LoggerManager, Math2D } from "@here/harp-utils";
import earcut from "earcut";
import * as THREE from "three";

import {
    normalizedEquirectangularProjection,
    ProjectionType,
    webMercatorProjection
} from "@here/harp-geoutils";

import { ILineGeometry, IPolygonGeometry } from "./IGeometryProcessor";
import { LinesGeometry } from "./OmvDataSource";
import { IOmvEmitter, OmvDecoder, Ring } from "./OmvDecoder";
import { tile2world, webMercatorTile2TargetWorld, world2tile } from "./OmvUtils";

// tslint:disable-next-line: max-line-length
import { SphericalGeometrySubdivisionModifier } from "@here/harp-geometry/lib/SphericalGeometrySubdivisionModifier";

const logger = LoggerManager.instance.create("OmvDecodedTileEmitter");

const tempTileOrigin = new THREE.Vector3();
const tempVertOrigin = new THREE.Vector3();
const tempVertNormal = new THREE.Vector3();
const tempFootDisp = new THREE.Vector3();
const tempRoofDisp = new THREE.Vector3();

const tmpV2 = new THREE.Vector2();
const tmpV3 = new THREE.Vector3();

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
 * Used to identify an invalid (or better: unused) array index.
 */
const INVALID_ARRAY_INDEX = -1;
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
     * Optional list of feature IDs. Currently only Number is supported, will fail if features have
     * IDs with type Long.
     */
    readonly featureIds: Array<number | undefined> = [];

    /**
     * Optional list of feature start indices. The indices point into the index attribute.
     */
    readonly featureStarts: number[] = [];

    /**
     * An optional list of additional data that can be used as additional data for the object
     * picking.
     */
    readonly objInfos: Array<{} | undefined> = [];

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

export enum LineType {
    Simple,
    Complex
}

type TexCoordsFunction = (tilePos: THREE.Vector2, tileExtents: number) => { u: number; v: number };

export class OmvDecodedTileEmitter implements IOmvEmitter {
    // mapping from style index to mesh buffers
    private readonly m_meshBuffers = new Map<number, MeshBuffers>();

    private readonly m_geometries: Geometry[] = [];
    private readonly m_textGeometries: TextGeometry[] = [];
    private readonly m_textPathGeometries: TextPathGeometry[] = [];
    private readonly m_poiGeometries: PoiGeometry[] = [];
    private readonly m_simpleLines: LinesGeometry[] = [];
    private readonly m_solidLines: LinesGeometry[] = [];
    private readonly m_dashedLines: LinesGeometry[] = [];

    private readonly m_sources: string[] = [];

    constructor(
        private readonly m_decodeInfo: OmvDecoder.DecodeInfo,
        private readonly m_styleSetEvaluator: StyleSetEvaluator,
        private readonly m_gatherFeatureIds: boolean,
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
     * @param layer Tile's layer to be processed.
     * @param extents Tile's layer extents.
     * @param geometry The current feature containing the main geometry.
     * @param env The [[MapEnv]] containing the environment information for the map.
     * @param techniques The array of [[Technique]] that will be applied to the geometry.
     * @param featureId The id of the feature.
     */
    processPointFeature(
        layer: string,
        extents: number,
        geometry: THREE.Vector2[],
        env: MapEnv,
        techniques: IndexedTechnique[],
        featureId: number | undefined
    ): void {
        this.processFeatureCommon(env);

        for (const technique of techniques) {
            if (technique === undefined) {
                continue;
            }

            const techniqueIndex = technique._index;
            const meshBuffers = this.findOrCreateMeshBuffers(techniqueIndex, GeometryType.Point);

            if (meshBuffers === undefined) {
                continue;
            }

            const { positions, texts, featureIds, imageTextures, objInfos } = meshBuffers;

            const shouldCreateTextGeometries =
                isTextTechnique(technique) || isPoiTechnique(technique);

            let imageTexture: string | undefined;
            const wantsPoi = isPoiTechnique(technique);

            if (wantsPoi) {
                const poiTechnique = technique as PoiTechnique;
                imageTexture = poiTechnique.imageTexture;

                // TODO: Move to decoder independent parts of code.
                if (typeof poiTechnique.poiName === "string") {
                    imageTexture = poiTechnique.poiName;
                } else if (typeof poiTechnique.poiNameField === "string") {
                    const poiNameFieldValue = env.lookup(poiTechnique.poiNameField) as string;
                    imageTexture = poiNameFieldValue;
                } else if (typeof poiTechnique.imageTextureField === "string") {
                    const imageTextureValue = env.lookup(poiTechnique.imageTextureField) as string;
                    imageTexture = composeTechniqueTextureName(imageTextureValue, poiTechnique);
                }
            }

            for (const pos of geometry) {
                if (shouldCreateTextGeometries) {
                    const textTechnique = technique as TextTechnique;
                    const textLabel = textTechnique.label;
                    const useAbbreviation = textTechnique.useAbbreviation as boolean;
                    const useIsoCode = textTechnique.useIsoCode as boolean;
                    const name =
                        typeof textLabel === "string"
                            ? env.lookup(textLabel)
                            : OmvDecoder.getFeatureName(
                                  env,
                                  useAbbreviation,
                                  useIsoCode,
                                  this.m_languages
                              );

                    if (name && typeof name === "string") {
                        texts.push(meshBuffers.addText(name));
                    } else {
                        texts.push(INVALID_ARRAY_INDEX);
                    }
                }

                // Always store the position, otherwise the following POIs will be
                // misplaced.
                webMercatorTile2TargetWorld(extents, this.m_decodeInfo, pos, tmpV3);
                positions.push(tmpV3.x, tmpV3.y, tmpV3.z);

                if (this.m_gatherFeatureIds) {
                    featureIds.push(featureId);
                    objInfos.push(env.entries);
                }
                if (isPoiTechnique) {
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
     * @param layer Tile's layer to be processed.
     * @param extents Tile's layer extents.
     * @param geometry The current feature containing the main geometry.
     * @param env The [[MapEnv]] containing the environment information for the map.
     * @param techniques The array of [[Technique]] that will be applied to the geometry.
     * @param featureId The id of the feature.
     */
    processLineFeature(
        layer: string,
        extents: number,
        geometry: ILineGeometry[],
        env: MapEnv,
        techniques: IndexedTechnique[],
        featureId: number | undefined
    ): void {
        this.processFeatureCommon(env);

        const lines: number[][] = [];
        const uvs: number[][] = [];
        const { projectedTileBounds } = this.m_decodeInfo;

        const tileWidth = projectedTileBounds.max.x - projectedTileBounds.min.x;
        const tileHeight = projectedTileBounds.max.y - projectedTileBounds.min.y;
        const tileSizeInMeters = Math.max(tileWidth, tileHeight);

        let computeTexCoords: TexCoordsFunction | undefined;
        let texCoordinateType: TextureCoordinateType | undefined;

        for (const technique of techniques) {
            if (technique === undefined) {
                continue;
            }
            if (!computeTexCoords) {
                computeTexCoords = this.getComputeTexCoordsFunc(technique);
                texCoordinateType = this.getTextureCoordinateType(technique);
            } else {
                // Support generation of only one type of texture coordinates.
                assert(texCoordinateType === this.getTextureCoordinateType(technique));
            }
        }

        for (const polyline of geometry) {
            const line: number[] = [];
            const lineUvs: number[] = [];
            polyline.positions.forEach(pos => {
                webMercatorTile2TargetWorld(extents, this.m_decodeInfo, pos, tmpV3);
                line.push(tmpV3.x, tmpV3.y, tmpV3.z);
                if (computeTexCoords) {
                    const { u, v } = computeTexCoords(pos, extents);
                    lineUvs.push(u, v);
                }
            });
            lines.push(line);
            uvs.push(lineUvs);
        }

        const wantCircle = this.m_decodeInfo.tileKey.level >= 11;

        for (const technique of techniques) {
            if (technique === undefined) {
                continue;
            }
            const techniqueIndex = technique._index;
            const techniqueName = technique.name;

            if (
                techniqueName === "line" ||
                techniqueName === "solid-line" ||
                techniqueName === "dashed-line"
            ) {
                const lineGeometry =
                    techniqueName === "line"
                        ? this.m_simpleLines
                        : techniqueName === "solid-line"
                        ? this.m_solidLines
                        : this.m_dashedLines;

                const lineType = techniqueName === "line" ? LineType.Simple : LineType.Complex;

                this.applyLineTechnique(
                    lineGeometry,
                    technique,
                    techniqueIndex,
                    this.m_gatherFeatureIds,
                    lineType,
                    featureId,
                    lines,
                    env,
                    this.getTextureCoordinateType(technique) ? uvs : undefined
                );
            } else if (
                isTextTechnique(technique) ||
                isPoiTechnique(technique) ||
                isLineMarkerTechnique(technique)
            ) {
                const textTechnique = technique as TextTechnique;
                const textLabel = textTechnique.label;
                const useAbbreviation = textTechnique.useAbbreviation as boolean;
                const useIsoCode = textTechnique.useIsoCode as boolean;
                let text =
                    typeof textLabel === "string"
                        ? env.lookup(textLabel)
                        : OmvDecoder.getFeatureName(
                              env,
                              useAbbreviation,
                              useIsoCode,
                              this.m_languages
                          );

                let validLines: number[][] = [];

                if (text === undefined) {
                    continue;
                }
                text = String(text);

                if (this.m_skipShortLabels) {
                    // Filter the lines, keep only those that are long enough for labelling.
                    validLines = [];

                    const metersPerPixel = tileSizeInMeters / this.m_decodeInfo.tileSizeOnScreen;
                    const minTileSpace =
                        MIN_AVERAGE_CHAR_WIDTH *
                        text.length *
                        metersPerPixel *
                        SIZE_ESTIMATION_FACTOR;

                    // Estimate if the line is long enough for the label, otherwise ignore it for
                    // rendering text. First, compute the bounding box in world coordinates.
                    for (const aLine of lines) {
                        let minX = Number.MAX_SAFE_INTEGER;
                        let maxX = Number.MIN_SAFE_INTEGER;
                        let minY = Number.MAX_SAFE_INTEGER;
                        let maxY = Number.MIN_SAFE_INTEGER;
                        for (let i = 0; i < aLine.length; i += 3) {
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

                        // Check if the diagonal of the bounding box would be long enough to fit the
                        // label text:
                        if (
                            (maxX - minX) * (maxX - minX) + (maxY - minY) * (maxY - minY) >=
                            minTileSpace * minTileSpace
                        ) {
                            validLines.push(aLine);
                        }
                    }
                } else {
                    validLines = lines;
                }

                if (validLines.length === 0) {
                    continue;
                }

                if (isTextTechnique(technique)) {
                    if (text === undefined) {
                        continue;
                    }
                    for (const aLine of validLines) {
                        const pathLengthSqr = Math2D.computeSquaredLineLength(aLine);
                        this.m_textPathGeometries.push({
                            technique: techniqueIndex,
                            path: aLine,
                            pathLengthSqr,
                            text: String(text),
                            featureId,
                            objInfos: this.m_gatherFeatureIds ? env.entries : undefined
                        });
                    }
                } else {
                    const lineMarkerTechnique = technique as LineMarkerTechnique;
                    let imageTexture = lineMarkerTechnique.imageTexture;

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
                                buffer: new Float32Array(aLine).buffer,
                                itemCount: 3
                            },
                            texts: [0],
                            stringCatalog: [text, imageTexture],
                            imageTextures: [1],
                            featureId,
                            objInfos: this.m_gatherFeatureIds ? [env.entries] : undefined
                        });
                    }
                }
            } else if (isExtrudedLineTechnique(technique)) {
                const meshBuffers = this.findOrCreateMeshBuffers(
                    techniqueIndex,
                    GeometryType.ExtrudedLine
                );
                if (meshBuffers === undefined) {
                    continue;
                }
                const {
                    positions,
                    indices,
                    groups,
                    featureIds,
                    featureStarts,
                    objInfos
                } = meshBuffers;
                const start = indices.length;

                const lineWidth = getPropertyValue(
                    technique.lineWidth,
                    this.m_decodeInfo.tileKey.level
                );

                if (lineWidth === undefined) {
                    continue;
                }

                const addCircle =
                    wantCircle && (technique.caps === undefined || technique.caps === "Circle");

                lines.forEach(aLine => {
                    triangulateLine(aLine, lineWidth, positions, indices, addCircle);

                    if (this.m_gatherFeatureIds) {
                        featureIds.push(featureId);
                        featureStarts.push(start);
                        objInfos.push(env.entries);
                    }
                });

                const count = indices.length - start;
                groups.push({ start, count, technique: techniqueIndex, featureId });
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
     * @param layer Tile's layer to be processed.
     * @param extents Tile's layer extents.
     * @param geometry The current feature containing the main geometry.
     * @param env The [[MapEnv]] containing the environment information for the map.
     * @param techniques The array of [[Technique]] that will be applied to the geometry.
     * @param featureId The id of the feature.
     */
    processPolygonFeature(
        layer: string,
        extents: number,
        geometry: IPolygonGeometry[],
        env: MapEnv,
        techniques: IndexedTechnique[],
        featureId: number | undefined
    ): void {
        this.processFeatureCommon(env);

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

            const polygons: Ring[][] = [];

            const isExtruded = isExtrudedPolygonTechnique(technique);
            const isFilled = isFillTechnique(technique);

            const isLine =
                isSolidLineTechnique(technique) ||
                isDashedLineTechnique(technique) ||
                isLineTechnique(technique);
            const isPolygon = isExtruded || isFilled || isStandardTechnique(technique);
            const computeTexCoords = this.getComputeTexCoordsFunc(technique);
            const vertexStride = computeTexCoords !== undefined ? 4 : 2;

            for (const polygon of geometry) {
                const rings: Ring[] = [];

                for (const outline of polygon.rings) {
                    const ringContour: number[] = [];

                    for (const coord of outline) {
                        ringContour.push(coord.x, coord.y);
                        if (computeTexCoords !== undefined) {
                            const { u, v } = computeTexCoords(coord, extents);
                            ringContour.push(u, v);
                        }
                    }

                    rings.push(new Ring(extents, vertexStride, ringContour));
                }

                polygons.push(rings);
            }

            if (isPolygon) {
                this.applyPolygonTechnique(
                    polygons,
                    technique,
                    techniqueIndex,
                    featureId,
                    env,
                    extents
                );
            } else if (isLine) {
                const lineGeometry =
                    technique.name === "line"
                        ? this.m_simpleLines
                        : technique.name === "solid-line"
                        ? this.m_solidLines
                        : this.m_dashedLines;

                const lineType = technique.name === "line" ? LineType.Simple : LineType.Complex;

                polygons.forEach(rings => {
                    const lines: number[][] = [];
                    rings.forEach(ring => {
                        const length = ring.contour.length / ring.vertexStride;
                        let line: number[] = [];
                        for (let i = 0; i < length; ++i) {
                            const nextIdx = (i + 1) % length;
                            const currX = ring.contour[i * ring.vertexStride];
                            const currY = ring.contour[i * ring.vertexStride + 1];
                            const nextX = ring.contour[nextIdx * ring.vertexStride];
                            const nextY = ring.contour[nextIdx * ring.vertexStride + 1];

                            const isOutline = !(
                                (currX <= 0 && nextX <= 0) ||
                                (currX >= ring.extents && nextX >= ring.extents) ||
                                (currY <= 0 && nextY <= 0) ||
                                (currY >= ring.extents && nextY >= ring.extents)
                            );

                            if (!isOutline && line.length !== 0) {
                                lines.push(line);
                                line = [];
                            } else if (isOutline && line.length === 0) {
                                webMercatorTile2TargetWorld(
                                    extents,
                                    this.m_decodeInfo,
                                    tmpV2.set(currX, currY),
                                    tmpV3
                                );
                                line.push(tmpV3.x, tmpV3.y, tmpV3.z);
                            }
                            if (isOutline) {
                                webMercatorTile2TargetWorld(
                                    extents,
                                    this.m_decodeInfo,
                                    tmpV2.set(nextX, nextY),
                                    tmpV3
                                );
                                line.push(tmpV3.x, tmpV3.y, tmpV3.z);
                            }
                        }
                        if (line.length) {
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
                        this.m_gatherFeatureIds,
                        lineType,
                        featureId,
                        lines,
                        env
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
        this.processLines(this.m_dashedLines);

        const decodedTile: DecodedTile = {
            techniques: this.m_styleSetEvaluator.techniques,
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
        if (this.m_sources.length !== 0) {
            decodedTile.copyrightHolderIds = this.m_sources;
        }
        return decodedTile;
    }

    private getTextureCoordinateType(technique: Technique): TextureCoordinateType | undefined {
        // Set TileSpace coordinate type to generate texture coordinates for the displacement map
        // used in elevation overlay.
        if (
            (isFillTechnique(technique) ||
                isSolidLineTechnique(technique) ||
                isDashedLineTechnique(technique) ||
                isExtrudedPolygonTechnique(technique)) &&
            this.m_enableElevationOverlay
        ) {
            return TextureCoordinateType.TileSpace;
        }

        return textureCoordinateType(technique);
    }

    private getComputeTexCoordsFunc(technique: Technique): TexCoordsFunction | undefined {
        const texCoordType = this.getTextureCoordinateType(technique);

        return texCoordType === TextureCoordinateType.TileSpace
            ? (tilePos: THREE.Vector2, tileExtents: number) => {
                  const { x: u, y: v } = new THREE.Vector2()
                      .copy(tilePos)
                      .divideScalar(tileExtents);
                  return { u, v: 1 - v };
              }
            : texCoordType === TextureCoordinateType.EquirectangularSpace
            ? (tilePos: THREE.Vector2, extents: number) => {
                  const worldPos = tile2world(extents, this.m_decodeInfo, tilePos);
                  const { x: u, y: v } = normalizedEquirectangularProjection.reprojectPoint(
                      webMercatorProjection,
                      new THREE.Vector3(worldPos.x, worldPos.y, 0)
                  );
                  return { u, v };
              }
            : undefined;
    }

    private applyLineTechnique(
        linesGeometry: LinesGeometry[],
        technique: Technique,
        techniqueIndex: number,
        gatherFeatureIds: boolean,
        lineType = LineType.Complex,
        featureId: number | undefined,
        lines: number[][],
        env: MapEnv,
        uvs?: number[][]
    ): void {
        const renderOrderOffset = technique.renderOrderBiasProperty
            ? env.lookup(technique.renderOrderBiasProperty)
            : 0;
        let lineGroup: LineGroup;
        const lineGroupGeometries = linesGeometry.find(aLine => {
            return (
                aLine.technique === techniqueIndex && aLine.renderOrderOffset === renderOrderOffset
            );
        });
        const hasNormalsAndUvs = uvs !== undefined;
        if (lineGroupGeometries === undefined) {
            lineGroup = new LineGroup(hasNormalsAndUvs, undefined, lineType === LineType.Simple);
            const aLine: LinesGeometry = {
                type: lineType === LineType.Complex ? GeometryType.SolidLine : GeometryType.Line,
                technique: techniqueIndex,
                renderOrderOffset:
                    renderOrderOffset !== undefined ? Number(renderOrderOffset) : undefined,
                lines: lineGroup
            };

            if (gatherFeatureIds) {
                // if this technique is transient, do not save the featureIds with the geometry
                aLine.featureIds = technique.transient === true ? undefined : [featureId];
                aLine.featureStarts = technique.transient === true ? undefined : [0];
            }

            linesGeometry.push(aLine);
        } else {
            lineGroup = lineGroupGeometries.lines;

            if (
                gatherFeatureIds &&
                lineGroupGeometries.featureIds &&
                lineGroupGeometries.featureStarts
            ) {
                // Add ID to tag the geometry, also provide the current length of the index
                // attribute
                lineGroupGeometries.featureIds.push(featureId);
                lineGroupGeometries.featureStarts.push(lineGroup.indices.length);
            }
        }
        let i = 0;
        lines.forEach(aLine => {
            lineGroup.add(this.m_decodeInfo.center, aLine, uvs ? uvs[i++] : undefined);
        });
    }

    private applyPolygonTechnique(
        polygons: Ring[][],
        technique: Technique,
        techniqueIndex: number,
        featureId: number | undefined,
        env: MapEnv,
        extents: number
    ): void {
        const isExtruded = isExtrudedPolygonTechnique(technique);

        const geometryType = isExtruded ? GeometryType.ExtrudedPolygon : GeometryType.Polygon;
        const meshBuffers = this.findOrCreateMeshBuffers(techniqueIndex, geometryType);

        if (meshBuffers === undefined) {
            return;
        }

        const extrudedPolygonTechnique = technique as ExtrudedPolygonTechnique;
        const fillTechnique = technique as FillTechnique;
        const boundaryWalls = extrudedPolygonTechnique.boundaryWalls !== false;

        const isFilled = isFillTechnique(technique);
        const texCoordType = this.getTextureCoordinateType(technique);

        // Get the height values for the footprint and extrusion.
        const currentHeight = env.lookup("height") as number;
        const currentMinHeight = env.lookup("min_height") as number;
        const defaultHeight = extrudedPolygonTechnique.defaultHeight;
        const constantHeight = extrudedPolygonTechnique.constantHeight;
        const minHeight = currentMinHeight !== undefined && !isFilled ? currentMinHeight : 0;
        const height =
            currentHeight !== undefined
                ? currentHeight
                : defaultHeight !== undefined
                ? defaultHeight
                : 0;

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

        const featureStride = texCoordType !== undefined ? 4 : 2;
        const vertexStride = featureStride + 2;
        const isSpherical = this.m_decodeInfo.targetProjection.type === ProjectionType.Spherical;

        const edgeWidth = isExtruded
            ? extrudedPolygonTechnique.lineWidth || 0.0
            : isFilled
            ? fillTechnique.lineWidth || 0.0
            : 0.0;
        const hasEdges = edgeWidth > 0.0;

        const color = new THREE.Color(
            extrudedPolygonTechnique.color !== undefined
                ? getPropertyValue(extrudedPolygonTechnique.color, this.m_decodeInfo.tileKey.level)
                : this.isColorStringValid(env.lookup("color") as string)
                ? (env.lookup("color") as string)
                : extrudedPolygonTechnique.defaultColor !== undefined
                ? getPropertyValue(
                      extrudedPolygonTechnique.defaultColor,
                      this.m_decodeInfo.tileKey.level
                  )
                : 0x000000
        );

        for (const polygon of polygons) {
            const startIndexCount = indices.length;

            for (let ringIndex = 0; ringIndex < polygon.length; ) {
                const vertices: number[] = [];
                const polygonBaseVertex = positions.length / 3;

                const { contour, winding } = polygon[ringIndex++];
                for (let i = 0; i < contour.length / featureStride; ++i) {
                    // Invert the Y component to preserve the correct winding without transforming
                    // from webMercator's local to global space.
                    for (let j = 0; j < featureStride; ++j) {
                        vertices.push((j === 1 ? -1 : 1) * contour[i * featureStride + j]);
                    }

                    // Calculate nextEdge and nextWall.
                    const nextIdx = (i + 1) % (contour.length / featureStride);
                    const currX = contour[i * featureStride];
                    const currY = contour[i * featureStride + 1];
                    const nextX = contour[nextIdx * featureStride];
                    const nextY = contour[nextIdx * featureStride + 1];
                    const insideExtents = !(
                        (currX <= 0 && nextX <= 0) ||
                        (currX >= extents && nextX >= extents) ||
                        (currY <= 0 && nextY <= 0) ||
                        (currY >= extents && nextY >= extents)
                    );

                    vertices.push(
                        insideExtents ? nextIdx : -1,
                        boundaryWalls || insideExtents ? nextIdx : -1
                    );
                }

                // Iterate over the inner rings. The inner rings have the opposite winding
                // of the outer rings.
                const holes: number[] = [];
                while (ringIndex < polygon.length && polygon[ringIndex].winding !== winding) {
                    const vertexOffset = vertices.length / vertexStride;
                    holes.push(vertexOffset);

                    const hole = polygon[ringIndex++].contour;
                    for (let i = 0; i < hole.length / featureStride; ++i) {
                        // Invert the Y component to preserve the correct winding without
                        // transforming from webMercator's local to global space.
                        for (let j = 0; j < featureStride; ++j) {
                            vertices.push((j === 1 ? -1 : 1) * hole[i * featureStride + j]);
                        }

                        // Calculate nextEdge and nextWall.
                        const nextIdx = (i + 1) % (hole.length / featureStride);
                        const currX = hole[i * featureStride];
                        const currY = hole[i * featureStride + 1];
                        const nextX = hole[nextIdx * featureStride];
                        const nextY = hole[nextIdx * featureStride + 1];
                        const insideExtents = !(
                            (currX <= 0 && nextX <= 0) ||
                            (currX >= extents && nextX >= extents) ||
                            (currY <= 0 && nextY <= 0) ||
                            (currY >= extents && nextY >= extents)
                        );

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
                                true
                            );
                            positionArray.push(worldPos.x, worldPos.y, 0);
                            if (texCoordType !== undefined) {
                                uvArray.push(vertices[i + 2], vertices[i + 3]);
                            }
                            edgeArray.push(vertices[i + featureStride]);
                            wallArray.push(vertices[i + featureStride + 1]);
                        }

                        // Create the temporary geometry used for subdivision.
                        const posAttr = new THREE.BufferAttribute(
                            new Float32Array(positionArray),
                            3
                        );
                        geom.addAttribute("position", posAttr);
                        let uvAttr: THREE.BufferAttribute | undefined;
                        if (texCoordType !== undefined) {
                            uvAttr = new THREE.BufferAttribute(new Float32Array(uvArray), 2);
                            geom.addAttribute("uv", uvAttr);
                        }
                        const edgeAttr = new THREE.BufferAttribute(new Float32Array(edgeArray), 1);
                        geom.addAttribute("edge", edgeAttr);
                        const wallAttr = new THREE.BufferAttribute(new Float32Array(wallArray), 1);
                        geom.addAttribute("wall", edgeAttr);
                        const indexAttr = new THREE.BufferAttribute(new Uint32Array(triangles), 1);
                        geom.setIndex(indexAttr);

                        // FIXME(HARP-5700): Subdivison modifer ignores texture coordinates.
                        const modifier = new SphericalGeometrySubdivisionModifier(
                            THREE.Math.degToRad(10),
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
                                tmpV2.set(posAttr.array[i], posAttr.array[i + 1]),
                                true
                            );
                            vertices.push(tilePos.x, tilePos.y);
                            if (texCoordType !== undefined) {
                                vertices.push(uvAttr!.array[(i / 3) * 2]);
                                vertices.push(uvAttr!.array[(i / 3) * 2 + 1]);
                            }
                            vertices.push(edgeAttr.array[i / 3]);
                            vertices.push(wallAttr.array[i / 3]);
                        }

                        triangles.push(...(geom.getIndex().array as Float32Array));
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
                            true
                        );

                        let scaleFactor = 1.0;
                        if (isExtruded && constantHeight !== true) {
                            tempVertOrigin.set(
                                tempTileOrigin.x + tmpV3.x,
                                tempTileOrigin.y + tmpV3.y,
                                tempTileOrigin.z + tmpV3.z
                            );
                            scaleFactor = this.m_decodeInfo.targetProjection.getScaleFactor(
                                tempVertOrigin
                            );
                        }

                        if (isSpherical) {
                            tempVertNormal
                                .set(tmpV3.x, tmpV3.y, tmpV3.z)
                                .add(this.center)
                                .normalize();
                        }

                        tempFootDisp.copy(tempVertNormal).multiplyScalar(minHeight * scaleFactor);
                        tempRoofDisp.copy(tempVertNormal).multiplyScalar(height * scaleFactor);
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
                            positions.push(
                                tmpV3.x + tempRoofDisp.x,
                                tmpV3.y + tempRoofDisp.y,
                                tmpV3.z + tempRoofDisp.z
                            );
                            extrusionAxis.push(
                                0,
                                0,
                                0,
                                tempRoofDisp.x - tempFootDisp.x,
                                tempRoofDisp.y - tempFootDisp.y,
                                tempRoofDisp.z - tempFootDisp.z
                            );
                            if (texCoordType !== undefined) {
                                textureCoordinates.push(vertices[i + 2], vertices[i + 3]);
                            }
                            if (this.m_enableElevationOverlay) {
                                normals.push(...tempVertNormal.toArray());
                            }
                            if (extrudedPolygonTechnique.vertexColors === true) {
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
            }

            if (this.m_gatherFeatureIds) {
                meshBuffers.objInfos.push(env.entries);
                meshBuffers.featureIds.push(featureId);
                meshBuffers.featureStarts.push(startIndexCount);
            }

            const count = indices.length - startIndexCount;
            if (count > 0) {
                groups.push({
                    start: startIndexCount,
                    count,
                    technique: techniqueIndex,
                    featureId
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

            const positionElements = new Float32Array(meshBuffers.positions);

            if (meshBuffers.texts.length > 0 && isTextTechnique(technique)) {
                this.m_textGeometries.push({
                    positions: {
                        name: "position",
                        type: "float",
                        buffer: positionElements.buffer as ArrayBuffer,
                        itemCount: 3
                    },
                    texts: meshBuffers.texts,
                    technique: techniqueIdx,
                    featureId: meshBuffers.featureIds ? meshBuffers.featureIds[0] : undefined,
                    stringCatalog: meshBuffers.stringCatalog,
                    objInfos: this.m_gatherFeatureIds ? meshBuffers.objInfos : undefined
                });
                return;
            }

            if (meshBuffers.texts.length > 0 && isPoiTechnique(technique)) {
                this.m_poiGeometries.push({
                    positions: {
                        name: "position",
                        type: "float",
                        buffer: positionElements.buffer as ArrayBuffer,
                        itemCount: 3
                    },
                    texts: meshBuffers.texts,
                    technique: techniqueIdx,
                    featureId: meshBuffers.featureIds ? meshBuffers.featureIds[0] : undefined,
                    stringCatalog: meshBuffers.stringCatalog,
                    imageTextures: meshBuffers.imageTextures,
                    objInfos: meshBuffers.objInfos
                });
                return;
            }

            if (meshBuffers.groups.length === 0) {
                // create a default group containing all the vertices in the position attribute.

                meshBuffers.groups.push({
                    start: 0,
                    count: positionElements.length / 3,
                    technique: techniqueIdx
                });
            }

            const geometry: Geometry = {
                type: meshBuffers.type,
                vertexAttributes: [
                    {
                        name: "position",
                        buffer: positionElements.buffer as ArrayBuffer,
                        itemCount: 3,
                        type: "float"
                    }
                ],
                groups: meshBuffers.groups
            };

            if (meshBuffers.normals.length > 0) {
                const normals = new Float32Array(meshBuffers.normals);
                assert(
                    normals.length === positionElements.length,
                    "length of normals buffer is different than the length of the " +
                        "position buffer"
                );

                geometry.vertexAttributes.push({
                    name: "normal",
                    buffer: normals.buffer as ArrayBuffer,
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

                geometry.vertexAttributes.push({
                    name: "color",
                    buffer: colors.buffer as ArrayBuffer,
                    itemCount: 3,
                    type: "float"
                });
            }

            if (meshBuffers.textureCoordinates.length > 0) {
                const positionCount = meshBuffers.positions.length / 3;
                const texCoordCount = meshBuffers.textureCoordinates.length / 2;
                assert(
                    texCoordCount === positionCount,
                    "length of textureCoordinates buffer is different than the length of the" +
                        "position buffer"
                );

                const textureCoordinates = new Float32Array(meshBuffers.textureCoordinates);
                geometry.vertexAttributes.push({
                    name: "uv",
                    buffer: textureCoordinates.buffer as ArrayBuffer,
                    itemCount: 2,
                    type: "float"
                });
            }

            if (meshBuffers.extrusionAxis.length > 0) {
                const extrusionAxis = new Float32Array(meshBuffers.extrusionAxis);
                assert(
                    extrusionAxis.length === positionElements.length,
                    "length of extrusionAxis buffer is different than the length of the " +
                        "position buffer"
                );

                geometry.vertexAttributes.push({
                    name: "extrusionAxis",
                    buffer: extrusionAxis.buffer as ArrayBuffer,
                    itemCount: 3,
                    type: "float"
                });
            }

            if (meshBuffers.indices.length > 0) {
                // TODO: use uint16 for buffers when possible
                geometry.index = {
                    name: "index",
                    buffer: new Uint32Array(meshBuffers.indices).buffer as ArrayBuffer,
                    itemCount: 1,
                    type: "uint32"
                };
            }

            if (meshBuffers.edgeIndices.length > 0) {
                // TODO: use uint16 for buffers when possible. Issue HARP-3987
                geometry.edgeIndex = {
                    name: "edgeIndex",
                    buffer: new Uint32Array(meshBuffers.edgeIndices as number[])
                        .buffer as ArrayBuffer,
                    itemCount: 1,
                    type: "uint32"
                };
            }

            if (this.m_gatherFeatureIds) {
                geometry.featureIds = meshBuffers.featureIds;
                geometry.featureStarts = meshBuffers.featureStarts;
                geometry.objInfos = meshBuffers.objInfos;
            }

            this.m_geometries.push(geometry);
        });
    }

    private processLines(linesArray: LinesGeometry[]) {
        linesArray.forEach(linesGeometry => {
            const { vertices, indices } = linesGeometry.lines;
            const renderOrderOffset = linesGeometry.renderOrderOffset;
            const technique = linesGeometry.technique;
            const buffer = new Float32Array(vertices).buffer as ArrayBuffer;
            const index = new Uint32Array(indices).buffer as ArrayBuffer;
            const attr: InterleavedBufferAttribute = {
                type: "float",
                stride: linesGeometry.lines.stride,
                buffer,
                attributes: linesGeometry.lines.vertexAttributes
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
                groups: [{ start: 0, count: indices.length, technique, renderOrderOffset }],
                vertexAttributes: []
            };

            if (this.m_gatherFeatureIds) {
                geometry.featureIds = linesGeometry.featureIds;
                geometry.featureStarts = linesGeometry.featureStarts;
            }

            this.m_geometries.push(geometry);
        });
    }

    private processSimpleLines(linesArray: LinesGeometry[]) {
        linesArray.forEach(linesGeometry => {
            const { vertices, indices } = linesGeometry.lines;
            const renderOrderOffset = linesGeometry.renderOrderOffset;
            const technique = linesGeometry.technique;
            const buffer = new Float32Array(vertices).buffer as ArrayBuffer;
            const index = new Uint32Array(indices).buffer as ArrayBuffer;
            const attr: BufferAttribute = {
                buffer,
                itemCount: 3,
                type: "float",
                name: "position"
            };
            const geometry: Geometry = {
                type: GeometryType.Line,
                index: {
                    buffer: index,
                    itemCount: 1,
                    type: "uint32",
                    name: "index"
                },
                vertexAttributes: [attr],
                groups: [{ start: 0, count: indices.length, technique, renderOrderOffset }]
            };

            if (this.m_gatherFeatureIds) {
                geometry.featureIds = linesGeometry.featureIds;
                geometry.featureStarts = linesGeometry.featureStarts;
            }
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

    private processFeatureCommon(env: MapEnv) {
        const source = env.lookup("source");
        if (typeof source === "string" && source !== "") {
            if (!this.m_sources.includes(source)) {
                this.m_sources.push(source);
            }
        }
    }

    private isColorStringValid(color: Value): boolean {
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
}
