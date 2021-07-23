/*
 * Copyright (C) 2020-2021 HERE Europe B.V.
 * Licensed under Apache 2.0, see full license in LICENSE
 * SPDX-License-Identifier: Apache-2.0
 */

import {
    AttributeMap,
    Env,
    getFeatureId,
    getPropertyValue,
    IndexedTechniqueParams,
    isTextTechnique,
    LineMarkerTechnique,
    MapEnv,
    PoiTechnique,
    TextTechnique
} from "@here/harp-datasource-protocol";
import {
    ContextualArabicConverter,
    TextLayoutStyle,
    TextRenderStyle
} from "@here/harp-text-canvas";
import { assert, LoggerManager, MathUtils } from "@here/harp-utils";

import { PoiBuilder } from "../poi/PoiBuilder";
import { TextElement } from "./TextElement";
import { DEFAULT_TEXT_DISTANCE_SCALE } from "./TextElementsRenderer";
import { TileTextStyleCache } from "./TileTextStyleCache";

const logger = LoggerManager.instance.create("TextElementBuilder");

/**
 * Constructs {@link TextElement} objects from {@link @here/harp-datasource-protocol/Technique},
 * text, coordinates and optional icon.
 */
export class TextElementBuilder {
    private m_priority?: number;
    private m_fadeNear?: number;
    private m_fadeFar?: number;
    private m_minZoomLevel?: number;
    private m_maxZoomLevel?: number;
    private m_distanceScale: number = DEFAULT_TEXT_DISTANCE_SCALE;
    private m_mayOverlap?: boolean;
    private m_reserveSpace?: boolean;
    private m_renderStyle?: TextRenderStyle;
    private m_layoutStype?: TextLayoutStyle;
    private m_technique?: (PoiTechnique | LineMarkerTechnique | TextTechnique) &
        IndexedTechniqueParams;

    private m_renderOrder: number;
    private m_xOffset?: number;
    private m_yOffset?: number;
    private m_poiBuilder?: PoiBuilder;
    private m_alwaysOnTop?: boolean;

    // Upper bound for render order values coming from a technique. The lowest upper bound
    // (`renderOrderUpBound`) will be smaller if `baseRenderOrder` is not an integer.
    static readonly RENDER_ORDER_UP_BOUND = 1e7;

    // Lowest upper bound for render order values, taking into account the `baseRenderOrder` given
    // at construction.
    readonly renderOrderUpBound: number;

    /**
     * Aligns a {@link TextElement}'s minZoomLevel and maxZoomLevel with values set in
     * {@link PoiInfo}.
     * @remarks Selects the smaller/larger one of the two min/max values for icon and text, because
     * the TextElement is a container for both.
     * @param textElement - The {@link TextElement} whose zoom level ranges will be aligned.
     */
    static alignZoomLevelRanges(textElement: TextElement): void {
        if (!textElement.poiInfo) {
            return;
        }
        const poiInfo = textElement.poiInfo;

        textElement.minZoomLevel =
            textElement.minZoomLevel ??
            MathUtils.min2(poiInfo.iconMinZoomLevel, poiInfo.textMinZoomLevel);

        textElement.maxZoomLevel =
            textElement.maxZoomLevel ??
            MathUtils.max2(poiInfo.iconMaxZoomLevel, poiInfo.textMaxZoomLevel);
    }

    /**
     * Combines two render order numbers into a single one.
     * @param baseRenderOrder - The most significative part of the render order.
     * @param offset - The least significative part of the render order. It must be within the
     * interval (-RENDER_ORDER_UP_BOUND, RENDER_ORDER_UP_BOUND).
     * @return The combined render order.
     */
    static composeRenderOrder(baseRenderOrder: number, offset: number): number {
        return baseRenderOrder * TextElementBuilder.RENDER_ORDER_UP_BOUND + offset;
    }

    /**
     * Constructor
     *
     * @param m_env - The {@link @link @here/harp-datasource-protocol#MapEnv} used to evaluate
     * technique properties.
     * @param m_styleCache - To cache instances of {@link @here/harp-text-canvas/TextRenderStyle}
     * and {@link @here/harp-text-canvas/TextLayoutStyle}.
     */
    constructor(
        private readonly m_env: MapEnv | Env,
        private readonly m_styleCache: TileTextStyleCache,
        private readonly m_baseRenderOrder: number
    ) {
        this.m_renderOrder = m_baseRenderOrder;

        if (Number.isInteger(m_baseRenderOrder)) {
            this.renderOrderUpBound = TextElementBuilder.RENDER_ORDER_UP_BOUND;
        } else {
            // If base render order is not an integer, lower render order upper bound to leave room
            // for the decimal places.
            const absBaseRenderOrder = Math.abs(m_baseRenderOrder);
            this.renderOrderUpBound =
                (absBaseRenderOrder - Math.floor(absBaseRenderOrder)) *
                TextElementBuilder.RENDER_ORDER_UP_BOUND;
        }

        if (!this.isValidRenderOrder(m_baseRenderOrder)) {
            logger.warn(
                `Large base render order (${m_baseRenderOrder}) might cause precision issues.`
            );
        }
    }

    /**
     * Sets a technique that will be used to create text elements on subsequent calls to
     * {@link TextElementBuilder.build} until the next call to this method.
     *
     * @param technique - The {@link @here/harp-datasource-protocol/Technique}.
     * @return This builder.
     */
    withTechnique(
        technique: (PoiTechnique | LineMarkerTechnique | TextTechnique) & IndexedTechniqueParams
    ): this {
        this.m_technique = technique;

        // Make sorting stable.
        this.m_priority = getPropertyValue(technique.priority, this.m_env) ?? 0;

        this.m_fadeNear = getPropertyValue(technique.fadeNear, this.m_env) ?? undefined;
        this.m_fadeFar = getPropertyValue(technique.fadeFar, this.m_env) ?? undefined;
        this.m_minZoomLevel = getPropertyValue(technique.minZoomLevel, this.m_env) ?? undefined;
        this.m_maxZoomLevel = getPropertyValue(technique.maxZoomLevel, this.m_env) ?? undefined;
        this.m_distanceScale = technique.distanceScale ?? DEFAULT_TEXT_DISTANCE_SCALE;
        this.m_renderStyle = this.m_styleCache.getRenderStyle(technique);
        this.m_layoutStype = this.m_styleCache.getLayoutStyle(technique);
        this.m_xOffset = getPropertyValue(technique.xOffset, this.m_env);
        this.m_yOffset = getPropertyValue(technique.yOffset, this.m_env);

        const techniqueRenderOrder = getPropertyValue(technique.renderOrder, this.m_env) ?? 0;

        if (!this.isValidRenderOrder(techniqueRenderOrder)) {
            const msg = `Unsupported large render order (${techniqueRenderOrder})`;
            logger.error(msg);
            assert(false, msg);
        }
        this.m_renderOrder = TextElementBuilder.composeRenderOrder(
            this.m_baseRenderOrder,
            techniqueRenderOrder
        );

        if (isTextTechnique(technique)) {
            this.withTextTechnique(technique);
        } else {
            this.withPoiTechnique(technique);
        }

        return this;
    }

    /**
     * Sets an icon that will be used to create text elements on subsequent calls to
     * {@link TextElementBuilder.build} until the next call to this method.
     *
     * @param imageTextureName - The name of the icon image.
     * @param shieldGroupIndex - Index to the shield group.
     * @return This builder.
     */
    withIcon(imageTextureName?: string, shieldGroupIndex?: number): this {
        assert(this.m_poiBuilder !== undefined);
        this.m_poiBuilder!.withIcon(imageTextureName, shieldGroupIndex);

        return this;
    }

    /**
     * Creates a {@link TextElement} with the given properties.
     *
     * @param text - The text to be displayed.
     * @param points - The position(s) for the text element.
     * @param tileOffset - The TextElement's tile offset, see {@link Tile.offset}.
     * @param dataSourceName - The name of the data source.
     * @param attributes - TextElement attribute map.
     * @param pathLengthSqr - Precomputed path length squared for path labels.
     * @return The created text element.
     */
    build(
        text: string,
        points: THREE.Vector3 | THREE.Vector3[],
        tileOffset: number,
        dataSourceName: string,
        dataSourceOrder: number,
        attributes?: AttributeMap,
        pathLengthSqr?: number,
        offsetDirection?: number
    ): TextElement {
        const featureId = getFeatureId(attributes);
        assert(this.m_technique !== undefined);
        assert(this.m_renderStyle !== undefined);
        assert(this.m_layoutStype !== undefined);

        const technique = this.m_technique!;
        const renderStyle = this.m_renderStyle!;
        const layoutStyle = this.m_layoutStype!;

        const textElement = new TextElement(
            ContextualArabicConverter.instance.convert(text),
            points,
            renderStyle,
            layoutStyle,
            this.m_priority,
            this.m_xOffset,
            this.m_yOffset,
            featureId,
            technique.style,
            this.m_fadeNear,
            this.m_fadeFar,
            tileOffset,
            offsetDirection,
            dataSourceName,
            dataSourceOrder
        );
        textElement.minZoomLevel = this.m_minZoomLevel;
        textElement.maxZoomLevel = this.m_maxZoomLevel;
        textElement.distanceScale = this.m_distanceScale;
        textElement.mayOverlap = this.m_mayOverlap;
        textElement.reserveSpace = this.m_reserveSpace;
        textElement.kind = technique.kind;
        // Get the userData for text element picking.
        textElement.userData = attributes;
        textElement.textFadeTime =
            technique.textFadeTime !== undefined ? technique.textFadeTime * 1000 : undefined;
        textElement.pathLengthSqr = pathLengthSqr;
        textElement.alwaysOnTop = this.m_alwaysOnTop;
        textElement.renderOrder = this.m_renderOrder;

        textElement.poiInfo = this.m_poiBuilder?.build(textElement);
        TextElementBuilder.alignZoomLevelRanges(textElement);

        return textElement;
    }

    private withTextTechnique(technique: TextTechnique & IndexedTechniqueParams) {
        this.m_mayOverlap = technique.mayOverlap === true;
        this.m_reserveSpace = technique.reserveSpace !== false;
        this.m_poiBuilder = undefined;
    }

    private withPoiTechnique(
        technique: (PoiTechnique | LineMarkerTechnique) & IndexedTechniqueParams
    ) {
        this.m_mayOverlap = technique.textMayOverlap === true;
        this.m_reserveSpace = technique.textReserveSpace !== false;
        this.m_alwaysOnTop = technique.alwaysOnTop === true;

        if (!this.m_poiBuilder) {
            this.m_poiBuilder = new PoiBuilder(this.m_env);
        }
        this.m_poiBuilder.withTechnique(technique);
    }

    private isValidRenderOrder(renderOrder: number) {
        return Math.abs(renderOrder) < this.renderOrderUpBound;
    }
}
