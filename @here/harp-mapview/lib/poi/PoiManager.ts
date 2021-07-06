/*
 * Copyright (C) 2019-2021 HERE Europe B.V.
 * Licensed under Apache 2.0, see full license in LICENSE
 * SPDX-License-Identifier: Apache-2.0
 */

import {
    AttributeMap,
    composeTechniqueTextureName,
    DecodedTile,
    ImageTexture,
    IndexedTechnique,
    isLineMarkerTechnique,
    isPoiTechnique,
    MapEnv,
    PoiGeometry
} from "@here/harp-datasource-protocol";
import { assert, assertExists, LoggerManager } from "@here/harp-utils";
import * as THREE from "three";

import { MapView } from "../MapView";
import { TextElement } from "../text/TextElement";
import { TextElementBuilder } from "../text/TextElementBuilder";
import { Tile } from "../Tile";
import { PoiTable } from "./PoiTableManager";

const logger = LoggerManager.instance.create("PoiManager");

/**
 * Interface for the {@link @here/harp-datasource-protocol#ImageTexture}s
 * that are defined in the atlas.
 */
interface ImageTextureDef {
    x: number;
    y: number;
    width: number;
    height: number;
    pixelRatio?: number;
}

function getImageTexture(poiGeometry: PoiGeometry, index: number = 0): string | undefined {
    if (poiGeometry.imageTextures) {
        const textureNameIndex = poiGeometry.imageTextures[index];
        if (textureNameIndex >= 0) {
            assert(poiGeometry.imageTextures.length > index);
            return poiGeometry.stringCatalog[textureNameIndex];
        }
    }
    return undefined;
}

function getAttributes(poiGeometry: PoiGeometry, index: number = 0): AttributeMap | undefined {
    return poiGeometry.objInfos ? poiGeometry.objInfos[index] : undefined;
}

function getPosition(
    positionAttribute: THREE.BufferAttribute,
    worldOffsetX: number,
    index: number = 0
): THREE.Vector3 {
    const position = new THREE.Vector3().fromBufferAttribute(positionAttribute, index);
    position.x += worldOffsetX;
    return position;
}

function getText(poiGeometry: PoiGeometry, index: number = 0): string {
    assert(poiGeometry.texts.length > index);
    const stringIndex = poiGeometry.texts[index];
    assert(poiGeometry.stringCatalog.length > stringIndex);
    return poiGeometry.stringCatalog[stringIndex] ?? "";
}

/**
 * POI manager class, responsible for loading the
 * {@link @here/harp-datasource-protocol#PoiGeometry} objects
 * from the {@link @here/harp-datasource-protocol#DecodedTile},
 * and preparing them for rendering.
 *
 * @remarks
 * Also loads and manages the texture atlases for the icons.
 */
export class PoiManager {
    // Keep track of the missing POI table names, but only warn once.
    private static readonly m_missingPoiTableName: Map<string, boolean> = new Map();
    private static readonly m_missingPoiName: Map<string, boolean> = new Map();

    /**
     * Warn about a missing POI table name, but only once.
     * @param poiTableName - POI mapping table name.
     * @param poiTable - POI table instance.
     */
    private static notifyMissingPoiTable(
        poiTableName: string,
        poiTable: PoiTable | undefined
    ): void {
        if (poiTableName === undefined) {
            poiTableName = "undefined";
        }
        if (PoiManager.m_missingPoiTableName.get(poiTableName) === undefined) {
            PoiManager.m_missingPoiTableName.set(poiTableName, true);
            if (poiTable !== undefined && !poiTable.loadedOk) {
                logger.error(`updatePoiFromPoiTable: Could not load POI table '${poiTableName}'!`);
            } else {
                logger.error(
                    `updatePoiFromPoiTable: No POI table with name '${poiTableName}' found!`
                );
            }
        }
    }

    /**
     * Warn about a missing POI name, but only once.
     * @param poiName - name of POI.
     * @param poiTableName - POI mapping table name.
     */
    private static notifyMissingPoi(poiName: string, poiTableName: string): void {
        if (poiName === undefined) {
            poiName = "undefined";
        }
        const key: string = `${poiTableName}[${poiName}]`;
        if (PoiManager.m_missingPoiName.get(key) === undefined) {
            PoiManager.m_missingPoiName.set(key, true);
            logger.warn(
                `updatePoiFromPoiTable: ` +
                    `Cannot find POI info for '${poiName}' in table '${poiTableName}'.`
            );
        }
    }

    private readonly m_imageTextures: Map<string, ImageTexture> = new Map();
    private readonly m_poiShieldGroups: Map<string, number> = new Map();

    /**
     * The constructor of the `PoiManager`.
     *
     * @param mapView - The {@link MapView} instance that should display the POIs.
     */
    constructor(readonly mapView: MapView) {}

    /**
     * Add all POIs from a decoded tile and store them as {@link TextElement}s in the {@link Tile}.
     *
     * Also handles LineMarkers, which is a recurring marker along a line (road).
     *
     * @param tile - Tile to add POIs to.
     * @param decodedTile - DecodedTile containing the raw
     *                      {@link @here/harp-datasource-protocol#PoiGeometry}
     *                      objects describing the POIs.
     */
    addPois(tile: Tile, decodedTile: DecodedTile): void {
        const poiGeometries = assertExists(decodedTile.poiGeometries);
        const worldOffsetX = tile.computeWorldOffsetX();

        const mapView = tile.mapView;
        const discreteZoomLevel = Math.floor(mapView.zoomLevel);
        const intZoomEnv = new MapEnv({ $zoom: discreteZoomLevel }, mapView.env);
        const poiBuilder = new TextElementBuilder(
            intZoomEnv,
            tile.textStyleCache,
            tile.dataSource.dataSourceOrder
        );

        for (const poiGeometry of poiGeometries) {
            assert(poiGeometry.technique !== undefined);
            const techniqueIndex = assertExists(poiGeometry.technique);
            const technique = decodedTile.techniques[techniqueIndex] as IndexedTechnique;

            if (
                technique._kindState === false ||
                (!isLineMarkerTechnique(technique) && !isPoiTechnique(technique))
            ) {
                continue;
            }

            if (technique.showOnMap === false) {
                continue;
            }

            const positions = new THREE.BufferAttribute(
                new Float64Array(poiGeometry.positions.buffer),
                poiGeometry.positions.itemCount
            );

            poiBuilder.withTechnique(technique);

            if (isLineMarkerTechnique(technique) && positions.count > 0) {
                this.addLineMarker(poiBuilder, tile, poiGeometry, positions, worldOffsetX);
            } else if (isPoiTechnique(technique)) {
                this.addPoi(poiBuilder, tile, poiGeometry, positions, worldOffsetX);
            }
        }
    }

    /**
     * Load the texture atlas that defines the segments of the texture that should be used for
     * specific icons.
     *
     * @remarks
     * Creates an {@link @here/harp-datasource-protocol#ImageTexture}
     * for every element in the atlas, such that it can
     * be addressed in the theme file.
     *
     * @param imageName - Name of the image from the theme (NOT the url!).
     * @param atlas - URL of the JSON file defining the texture atlas.
     * @param abortSignal - Signal to Abort the loading of the Atlas Image
     */
    async addTextureAtlas(imageName: string, atlas: string, abortSignal?: AbortSignal) {
        const response = await fetch(atlas, { signal: abortSignal });
        if (!response.ok) {
            throw new Error(`addTextureAtlas: Cannot load textureAtlas: ${response.statusText}`);
        }
        try {
            const jsonAtlas: any | undefined = await response.json();

            if (jsonAtlas === undefined) {
                logger.info(`addTextureAtlas: TextureAtlas empty: ${atlas}`);
                return;
            }

            logger.debug(
                `addTextureAtlas: Loading textureAtlas '${atlas}' for image '${imageName}'`
            );
            for (const textureName of Object.getOwnPropertyNames(jsonAtlas)) {
                const imageTextureDef = jsonAtlas[textureName] as ImageTextureDef;

                const imageTexture: ImageTexture = {
                    name: textureName,
                    image: imageName,
                    xOffset: imageTextureDef.x,
                    yOffset: imageTextureDef.y,
                    width: imageTextureDef.width,
                    height: imageTextureDef.height
                };

                this.addImageTexture(imageTexture);
            }
            this.mapView.update();
        } catch (error) {
            logger.error(`addTextureAtlas: Failed to load textureAtlas '${atlas}' : ${error}`);
        }
    }

    /**
     * Add an {@link @here/harp-datasource-protocol#ImageTexture} such that it
     * is available as a named entity for techniques in theme files.
     *
     * @param imageTexture - {@link @here/harp-datasource-protocol#ImageTexture}
     *                       that should be available for POIs.
     */
    addImageTexture(imageTexture: ImageTexture) {
        if (imageTexture.name === undefined) {
            logger.error("addImageTexture: Name required", imageTexture);
            return;
        }
        if (this.m_imageTextures.get(imageTexture.name) !== undefined) {
            logger.warn(
                `addImageTexture: Name already used: ${imageTexture.name}` + ` (overriding it)`
            );
        }

        this.m_imageTextures.set(imageTexture.name, imageTexture);
    }

    /**
     * Return the {@link @here/harp-datasource-protocol#ImageTexture}
     * registered under the specified name.
     *
     * @param name - Name of the {@link @here/harp-datasource-protocol#ImageTexture}.
     */
    getImageTexture(name: string): ImageTexture | undefined {
        return this.m_imageTextures.get(name);
    }

    /**
     * Update the {@link TextElement} with the information taken from the {@link PoiTable} which is
     * referenced in the {@link PoiInfo} of the pointLabel.
     *
     * If the requested {@link PoiTable} is not available yet, the function returns `false`.
     * If the {@link PoiTable} is not defined, or if the references POI has no entry in
     * the {@link PoiTable}, no action is taken, and the function returns `false`.
     *
     * If the {@link PoiTable} has been processed, it returns `true`, indicating that this function
     * doesn't have to be called again.
     *
     * @param pointLabel - The {@link TextElement} to update.
     *
     * @returns `true` if the {@link PoiTable} has been processed, and the
     *          function does not have to be called again.
     */
    updatePoiFromPoiTable(pointLabel: TextElement): boolean {
        const poiInfo = pointLabel.poiInfo;
        // PoiTable requires poiName to be defined otherwise mapping via PoiTable is
        // not possible, such as table key is not defined.
        if (!poiInfo || poiInfo.poiTableName === undefined || poiInfo.poiName === undefined) {
            return true;
        }

        // Try to acquire PoiTable
        const poiTableName = poiInfo.poiTableName;
        const poiTable = this.mapView.poiTableManager.getPoiTable(poiTableName);

        // Check if PoiTable is found, but its still loading.
        if (poiTable && poiTable.isLoading) {
            // The PoiTable is still loading, we have to try again.
            return false;
        }

        // Remove poiTableName to mark this POI as processed.
        poiInfo.poiTableName = undefined;

        // PoiTable not found or can not be loaded.
        if (!poiTable || !poiTable.loadedOk) {
            PoiManager.notifyMissingPoiTable(poiTableName, poiTable);
            return true;
        }

        // Try to acquire PoiTableEntry.
        const poiName = poiInfo.poiName;
        const poiTableEntry = poiTable.getEntry(poiName);
        if (!poiTableEntry) {
            PoiManager.notifyMissingPoi(poiName, poiTableName);
            return true;
        }

        if (poiTableEntry.iconName !== undefined && poiTableEntry.iconName.length > 0) {
            poiInfo.imageTextureName = composeTechniqueTextureName(
                poiTableEntry.iconName,
                poiInfo.technique
            );
        }

        pointLabel.visible = poiTableEntry.visible ?? pointLabel.visible;
        pointLabel.priority = poiTableEntry.priority ?? pointLabel.priority;
        poiInfo.iconMinZoomLevel = poiTableEntry.iconMinLevel ?? poiInfo.iconMinZoomLevel;
        poiInfo.iconMaxZoomLevel = poiTableEntry.iconMaxLevel ?? poiInfo.iconMaxZoomLevel;
        poiInfo.textMinZoomLevel = poiTableEntry.textMinLevel ?? poiInfo.textMinZoomLevel;
        poiInfo.textMaxZoomLevel = poiTableEntry.textMaxLevel ?? poiInfo.textMaxZoomLevel;

        TextElementBuilder.alignZoomLevelRanges(pointLabel);

        return true;
    }

    /**
     * Clear internal state. Applicable when switching themes.
     */
    clear() {
        this.m_imageTextures.clear();
        this.m_poiShieldGroups.clear();
    }

    /**
     * Add the LineMarker as a POI with multiple positions sharing the same `shieldGroupIndex`.
     */
    private addLineMarker(
        poiBuilder: TextElementBuilder,
        tile: Tile,
        poiGeometry: PoiGeometry,
        positions: THREE.BufferAttribute,
        worldOffsetX: number
    ) {
        const text = getText(poiGeometry);
        const imageTextureName = getImageTexture(poiGeometry);

        // let the combined image texture name (name of image in atlas, not the URL) and
        // text of the shield be the group key, at worst scenario it may be: "undefined-"
        const groupKey = imageTextureName + "-" + text;
        let shieldGroupIndex = this.m_poiShieldGroups.get(groupKey);
        if (shieldGroupIndex === undefined) {
            shieldGroupIndex = this.m_poiShieldGroups.size;
            this.m_poiShieldGroups.set(groupKey, shieldGroupIndex);
        }

        const positionArray: THREE.Vector3[] = [];
        for (let i = 0; i < positions.count; i += 3) {
            positionArray.push(getPosition(positions, worldOffsetX, i));
        }
        const textElement = poiBuilder
            .withIcon(imageTextureName, shieldGroupIndex)
            .build(
                text,
                positionArray,
                tile.offset,
                tile.dataSource.name,
                tile.dataSource.dataSourceOrder,
                getAttributes(poiGeometry)
            );

        tile.addTextElement(textElement);
    }

    /**
     * Create and add POI {@link TextElement}s to tile with a series of positions.
     */
    private addPoi(
        poiBuilder: TextElementBuilder,
        tile: Tile,
        poiGeometry: PoiGeometry,
        positions: THREE.BufferAttribute,
        worldOffsetX: number
    ) {
        for (let i = 0; i < positions.count; ++i) {
            const offsetDirection = poiGeometry.offsetDirections?.[i] ?? 0;

            const textElement = poiBuilder
                .withIcon(getImageTexture(poiGeometry, i))
                .build(
                    getText(poiGeometry, i),
                    getPosition(positions, worldOffsetX, i),
                    tile.offset,
                    tile.dataSource.name,
                    tile.dataSource.dataSourceOrder,
                    getAttributes(poiGeometry, i),
                    undefined,
                    offsetDirection
                );

            tile.addTextElement(textElement);
        }
    }
}
