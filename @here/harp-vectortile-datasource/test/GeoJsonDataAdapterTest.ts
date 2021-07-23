/*
 * Copyright (C) 2021 HERE Europe B.V.
 * Licensed under Apache 2.0, see full license in LICENSE
 * SPDX-License-Identifier: Apache-2.0
 */

import { mercatorProjection } from "@here/harp-geoutils/lib/projection/MercatorProjection";
import { TileKey } from "@here/harp-geoutils/lib/tiling/TileKey";
import { expect } from "chai";
import * as sinon from "sinon";

import {
    GeoJsonDataAdapter,
    GeoJsonFeatureCollection
} from "../lib/adapters/geojson/GeoJsonDataAdapter";
import { DecodeInfo } from "../lib/DecodeInfo";
import { MockGeometryProcessor } from "./MockGeometryProcessor";

const featureCollection: GeoJsonFeatureCollection = {
    type: "FeatureCollection",
    features: [
        {
            type: "Feature",
            id: "point id",
            properties: {},

            geometry: {
                type: "Point",
                coordinates: [1, 2]
            }
        },
        {
            type: "Feature",
            id: "line id",
            properties: {},

            geometry: {
                type: "LineString",
                coordinates: [
                    [1, 2],
                    [3, 4]
                ]
            }
        },
        {
            type: "Feature",
            id: "polygon id",
            properties: {},

            geometry: {
                type: "Polygon",
                coordinates: [
                    [
                        [1, 2],
                        [3, 4],
                        [5, 6]
                    ]
                ]
            }
        }
    ]
};

describe("GeoJsonDataAdapter", function () {
    let adapter: GeoJsonDataAdapter;

    beforeEach(function () {
        adapter = new GeoJsonDataAdapter();
    });

    it("canProcess returns true for a FeatureCollection", function () {
        expect(adapter.canProcess(featureCollection as any)).to.be.true;
    });

    it("sets the specified layer name", () => {
        const decodeInfo = new DecodeInfo(mercatorProjection, new TileKey(0, 0, 1));
        const geometryProcessor = new MockGeometryProcessor();

        const pointSpy = sinon.spy(geometryProcessor, "processPointFeature");
        const lineSpy = sinon.spy(geometryProcessor, "processLineFeature");
        const polygonSpy = sinon.spy(geometryProcessor, "processPolygonFeature");

        const LAYER_NAME = "foo";

        adapter.process(featureCollection, decodeInfo, geometryProcessor, LAYER_NAME);

        sinon.assert.calledOnce(pointSpy);
        sinon.assert.calledWith(
            pointSpy,
            LAYER_NAME,
            sinon.match.number,
            sinon.match.array,
            sinon.match.object
        );

        sinon.assert.calledOnce(lineSpy);
        sinon.assert.calledWith(
            lineSpy,
            LAYER_NAME,
            sinon.match.number,
            sinon.match.array,
            sinon.match.object
        );

        sinon.assert.calledOnce(polygonSpy);
        sinon.assert.calledWith(
            polygonSpy,
            LAYER_NAME,
            sinon.match.number,
            sinon.match.array,
            sinon.match.object
        );
    });
});
