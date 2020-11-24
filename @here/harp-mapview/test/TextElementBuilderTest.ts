/*
 * Copyright (C) 2020 HERE Europe B.V.
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
import { TextLayoutStyle, TextRenderStyle } from "@here/harp-text-canvas";
import { expect } from "chai";
import { Vector3 } from "three";

import { TextElementBuilder } from "../lib/text/TextElementBuilder";
import { TileTextStyleCache } from "../lib/text/TileTextStyleCache";

describe("TextElementBuilder", function() {
    const env = new Env();
    const renderStyle = new TextRenderStyle();
    const layoutStyle = new TextLayoutStyle();
    const styleCache = ({
        getRenderStyle: () => renderStyle,
        getLayoutStyle: () => layoutStyle
    } as any) as TileTextStyleCache;

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
        const label1 = builder.withTechnique(textTechnique).build("one", new Vector3(), 0);
        const label2 = builder.build("two", new Vector3(), 0);

        expect(label1?.priority)
            .equals(label2?.priority)
            .and.equals(textTechnique.priority);
    });

    it("reuses same imageTextureName and shield group index between calls to withIcon", () => {
        const poiTechnique = buildPoiTechnique({});
        const builder = new TextElementBuilder(env, styleCache, 0);
        const iconName = "dummy";
        const shieldGroupIndex = 42;
        const label1 = builder
            .withTechnique(poiTechnique)
            .withIcon(iconName, shieldGroupIndex)
            .build("one", new Vector3(), 0);
        const label2 = builder.build("two", new Vector3(), 0);

        expect(label1.poiInfo?.imageTextureName)
            .equals(label2.poiInfo?.imageTextureName)
            .and.equals(iconName);
        expect(label1.poiInfo?.shieldGroupIndex)
            .equals(label2.poiInfo?.shieldGroupIndex)
            .and.equals(shieldGroupIndex);
    });

    it("uses textMayOverlap and textReserveSpace for marker techniques", () => {
        const poiTechnique = buildPoiTechnique({ textMayOverlap: true, textReserveSpace: false });
        const lineMarkerTechnique = buildLineMarkerTechnique({
            textMayOverlap: false,
            textReserveSpace: true
        });
        const builder = new TextElementBuilder(env, styleCache, 0);
        const poi = builder.withTechnique(poiTechnique).build("", new Vector3(), 0);
        const lineMarker = builder.withTechnique(lineMarkerTechnique).build("", new Vector3(), 0);

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
            .build("", new Vector3(), 0);
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
            .build("", new Vector3(), 0);
        expect(poi.minZoomLevel).equals(Math.min(iconMinZoomLevel, textMinZoomLevel));
        expect(poi.maxZoomLevel).equals(Math.max(iconMaxZoomLevel, textMaxZoomLevel));
    });

    it("sets renderOrder on text element and poi info", () => {
        const poiTechnique = buildPoiTechnique({ renderOrder: 42 });
        const poi = new TextElementBuilder(env, styleCache, 0)
            .withTechnique(poiTechnique)
            .withIcon("dummy")
            .build("", new Vector3(), 0);
        // bigints must be converted to string before asserting, Mocha's error serializer does not
        // support bigint type: https://github.com/mochajs/mocha/issues/4090
        expect(poi.renderOrder.toString())
            .equals(poi.poiInfo?.renderOrder?.toString())
            .and.equals(BigInt(poiTechnique.renderOrder).toString());
    });

    it("combines baseRenderOrder and technique's renderOrder into a single render order", () => {
        const poiTechnique = buildPoiTechnique({ renderOrder: 42 });
        const baseRenderOrder = 1;
        const poi = new TextElementBuilder(env, styleCache, baseRenderOrder)
            .withTechnique(poiTechnique)
            .withIcon("dummy")
            .build("", new Vector3(), 0);
        // bigints must be converted to string before asserting, Mocha's error serializer does not
        // support bigint type: https://github.com/mochajs/mocha/issues/4090
        expect(poi.renderOrder.toString(16))
            .equals(poi.poiInfo?.renderOrder?.toString(16))
            .and.equals(
                TextElementBuilder.composeRenderOrder(
                    baseRenderOrder,
                    poiTechnique.renderOrder as number
                ).toString(16)
            );
    });

    it("composeRenderOrder", () => {
        expect(
            TextElementBuilder.composeRenderOrder(0, 0) <
                TextElementBuilder.composeRenderOrder(0, 1)
        ).true;

        expect(
            TextElementBuilder.composeRenderOrder(0xffffffff, 0xfffffffe) <
                TextElementBuilder.composeRenderOrder(0xffffffff, 0xffffffff)
        ).true;

        expect(
            TextElementBuilder.composeRenderOrder(0, 0xffffffff) <
                TextElementBuilder.composeRenderOrder(1, 0)
        ).true;

        expect(
            TextElementBuilder.composeRenderOrder(0, -1) <
                TextElementBuilder.composeRenderOrder(0, 0)
        ).true;

        expect(
            TextElementBuilder.composeRenderOrder(-1, 0) <
                TextElementBuilder.composeRenderOrder(0, -0xffffffff)
        ).true;

        expect(
            TextElementBuilder.composeRenderOrder(-0xffffffff, -0xffffffff) <
                TextElementBuilder.composeRenderOrder(-0xffffffff, -0xfffffffe)
        ).true;
    });
});
