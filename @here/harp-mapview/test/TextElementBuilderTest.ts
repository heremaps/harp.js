/*
 * Copyright (C) 2020-2021 HERE Europe B.V.
 * Licensed under Apache 2.0, see full license in LICENSE
 * SPDX-License-Identifier: Apache-2.0
 */

import {
    Env,
    IndexedTechniqueParams,
    LineMarkerTechnique,
    PoiTechnique,
    TextTechnique
} from "@here/harp-datasource-protocol";
import { silenceLoggingAroundFunction } from "@here/harp-test-utils";
import { TextLayoutStyle, TextRenderStyle } from "@here/harp-text-canvas";
import { LogLevel } from "@here/harp-utils";
import { expect } from "chai";
import { Vector3 } from "three";

import { TextElementBuilder } from "../lib/text/TextElementBuilder";
import { TileTextStyleCache } from "../lib/text/TileTextStyleCache";

describe("TextElementBuilder", function () {
    const env = new Env();
    const renderStyle = new TextRenderStyle();
    const layoutStyle = new TextLayoutStyle();
    const styleCache = ({
        getRenderStyle: () => renderStyle,
        getLayoutStyle: () => layoutStyle
    } as any) as TileTextStyleCache;
    const dataSourceName = "anonymous";
    const dataSourceOrder = 0;

    function buildPoiTechnique(properties: {}): PoiTechnique & IndexedTechniqueParams {
        return { name: "labeled-icon", _index: 0, _styleSetIndex: 0, ...properties };
    }

    function buildLineMarkerTechnique(properties: {}): LineMarkerTechnique &
        IndexedTechniqueParams {
        return { name: "line-marker", _index: 0, _styleSetIndex: 0, ...properties };
    }

    function buildTextTechnique(properties: {}): TextTechnique & IndexedTechniqueParams {
        return { name: "text", _index: 0, _styleSetIndex: 0, ...properties };
    }

    it("reuses same technique between calls to withTechnique", () => {
        const textTechnique = buildTextTechnique({ priority: 42 });
        const builder = new TextElementBuilder(env, styleCache, 0);
        const label1 = builder
            .withTechnique(textTechnique)
            .build("one", new Vector3(), 0, dataSourceName, dataSourceOrder);
        const label2 = builder.build("two", new Vector3(), 0, dataSourceName, dataSourceOrder);

        expect(label1?.priority).equals(label2?.priority).and.equals(textTechnique.priority);
    });

    it("reuses same imageTextureName and shield group index between calls to withIcon", () => {
        const poiTechnique = buildPoiTechnique({});
        const builder = new TextElementBuilder(env, styleCache, 0);
        const iconName = "dummy";
        const shieldGroupIndex = 42;
        const label1 = builder
            .withTechnique(poiTechnique)
            .withIcon(iconName, shieldGroupIndex)
            .build("one", new Vector3(), 0, dataSourceName, dataSourceOrder);
        const label2 = builder.build("two", new Vector3(), 0, dataSourceName, dataSourceOrder);

        expect(label1.poiInfo?.imageTextureName)
            .equals(label2.poiInfo?.imageTextureName)
            .and.equals(iconName);
        expect(label1.poiInfo?.shieldGroupIndex)
            .equals(label2.poiInfo?.shieldGroupIndex)
            .and.equals(shieldGroupIndex);

        expect(label1.dataSourceName).equals(dataSourceName);
        expect(label2.dataSourceName).equals(dataSourceName);
    });

    it("uses textMayOverlap and textReserveSpace for marker techniques", () => {
        const poiTechnique = buildPoiTechnique({ textMayOverlap: true, textReserveSpace: false });
        const lineMarkerTechnique = buildLineMarkerTechnique({
            textMayOverlap: false,
            textReserveSpace: true
        });
        const builder = new TextElementBuilder(env, styleCache, 0);
        const poi = builder
            .withTechnique(poiTechnique)
            .build("", new Vector3(), 0, dataSourceName, dataSourceOrder);
        const lineMarker = builder
            .withTechnique(lineMarkerTechnique)
            .build("", new Vector3(), 0, dataSourceName, dataSourceOrder);

        expect(poi.mayOverlap).equals(poiTechnique.textMayOverlap);
        expect(poi.reserveSpace).equals(poiTechnique.textReserveSpace);
        expect(lineMarker.mayOverlap).equals(lineMarkerTechnique.textMayOverlap);
        expect(lineMarker.reserveSpace).equals(lineMarkerTechnique.textReserveSpace);
    });

    it("does not set PoiInfo if no imageTextureName or poiName set", () => {
        const poiTechnique = buildPoiTechnique({});
        const poi = new TextElementBuilder(env, styleCache, 0)
            .withTechnique(poiTechnique)
            .withIcon(undefined)
            .build("", new Vector3(), 0, dataSourceName, dataSourceOrder);
        expect(poi.poiInfo).undefined;
    });

    it("aligns zoom level ranges", () => {
        const iconMinZoomLevel = 5;
        const textMinZoomLevel = 3;
        const iconMaxZoomLevel = 17;
        const textMaxZoomLevel = 15;
        const poiTechnique = buildPoiTechnique({
            iconMinZoomLevel,
            textMinZoomLevel,
            iconMaxZoomLevel,
            textMaxZoomLevel
        });
        const poi = new TextElementBuilder(env, styleCache, 0)
            .withTechnique(poiTechnique)
            .withIcon("")
            .build("", new Vector3(), 0, dataSourceName, dataSourceOrder);
        expect(poi.minZoomLevel).equals(Math.min(iconMinZoomLevel, textMinZoomLevel));
        expect(poi.maxZoomLevel).equals(Math.max(iconMaxZoomLevel, textMaxZoomLevel));
    });

    it("sets renderOrder on text element and poi info", () => {
        const poiTechnique = buildPoiTechnique({ renderOrder: 42 });
        const poi = new TextElementBuilder(env, styleCache, 0)
            .withTechnique(poiTechnique)
            .withIcon("dummy")
            .build("", new Vector3(), 0, dataSourceName, dataSourceOrder);
        expect(poi.renderOrder)
            .equals(poi.poiInfo?.renderOrder)
            .and.equals(poiTechnique.renderOrder);
    });

    it("combines baseRenderOrder and technique's renderOrder into a single render order", () => {
        const poiTechnique = buildPoiTechnique({ renderOrder: 42 });
        const baseRenderOrder = 1;
        const poi = new TextElementBuilder(env, styleCache, baseRenderOrder)
            .withTechnique(poiTechnique)
            .withIcon("dummy")
            .build("", new Vector3(), 0, dataSourceName, dataSourceOrder);
        expect(poi.renderOrder)
            .equals(poi.poiInfo?.renderOrder)
            .and.equals(
                TextElementBuilder.composeRenderOrder(
                    baseRenderOrder,
                    poiTechnique.renderOrder as number
                )
            );
    });

    it("withTechnique throws if positive renderOrder is >= than upper bound", async () => {
        const builder = new TextElementBuilder(env, styleCache, 0);

        const poiTechnique = buildPoiTechnique({
            renderOrder: builder.renderOrderUpBound
        });

        await silenceLoggingAroundFunction(
            "TextElementBuilder",
            () => {
                expect(builder.withTechnique.bind(builder, poiTechnique)).throws();
            },
            LogLevel.None
        );
    });

    it("withTechnique throws if negative renderOrder is <= than lower bound", async () => {
        const builder = new TextElementBuilder(env, styleCache, 0);

        const poiTechnique = buildPoiTechnique({
            renderOrder: -builder.renderOrderUpBound
        });

        await silenceLoggingAroundFunction(
            "TextElementBuilder",
            () => {
                expect(builder.withTechnique.bind(builder, poiTechnique)).throws();
            },
            LogLevel.None
        );
    });

    it("withTechnique throws if renderOrder is >= than adjusted upper bound", async () => {
        const builder = new TextElementBuilder(env, styleCache, 0.01);

        const poiTechnique = buildPoiTechnique({
            renderOrder: builder.renderOrderUpBound
        });

        await silenceLoggingAroundFunction(
            "TextElementBuilder",
            () => {
                expect(builder.withTechnique.bind(builder, poiTechnique)).throws();
            },
            LogLevel.None
        );
    });

    it("composeRenderOrder", () => {
        expect(TextElementBuilder.composeRenderOrder(0, 0)).lessThan(
            TextElementBuilder.composeRenderOrder(0, 1)
        );

        expect(
            TextElementBuilder.composeRenderOrder(
                TextElementBuilder.RENDER_ORDER_UP_BOUND - 1,
                TextElementBuilder.RENDER_ORDER_UP_BOUND - 2
            )
        ).lessThan(
            TextElementBuilder.composeRenderOrder(
                TextElementBuilder.RENDER_ORDER_UP_BOUND - 1,
                TextElementBuilder.RENDER_ORDER_UP_BOUND - 1
            )
        );

        expect(
            TextElementBuilder.composeRenderOrder(0, TextElementBuilder.RENDER_ORDER_UP_BOUND - 1)
        ).lessThan(TextElementBuilder.composeRenderOrder(1, 0));

        expect(TextElementBuilder.composeRenderOrder(0, -1)).lessThan(
            TextElementBuilder.composeRenderOrder(0, 0)
        );

        expect(TextElementBuilder.composeRenderOrder(-1, 0)).lessThan(
            TextElementBuilder.composeRenderOrder(0, -TextElementBuilder.RENDER_ORDER_UP_BOUND + 1)
        );

        expect(
            TextElementBuilder.composeRenderOrder(
                -TextElementBuilder.RENDER_ORDER_UP_BOUND + 1,
                -TextElementBuilder.RENDER_ORDER_UP_BOUND + 1
            )
        ).lessThan(
            TextElementBuilder.composeRenderOrder(
                -TextElementBuilder.RENDER_ORDER_UP_BOUND + 1,
                -TextElementBuilder.RENDER_ORDER_UP_BOUND + 2
            )
        );
    });
});
