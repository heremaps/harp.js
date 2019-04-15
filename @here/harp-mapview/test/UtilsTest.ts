/*
 * Copyright (C) 2017-2019 HERE Europe B.V.
 * Licensed under Apache 2.0, see full license in LICENSE
 * SPDX-License-Identifier: Apache-2.0
 */

// tslint:disable:only-arrow-functions
//    Mocha discourages using arrow functions, see https://mochajs.org/#arrow-functions

import { GeoCoordinates, MathUtils, mercatorProjection, TileKey } from "@here/harp-geoutils";
import { expect } from "chai";
import * as THREE from "three";
import { MapView } from "../lib/MapView";
import { MapViewUtils, TileOffsetUtils } from "../lib/Utils";

const cameraMock = {
    fov: 40,
    rotation: {
        z: 0
    },
    quaternion: new THREE.Quaternion()
};

describe("map-view#Utils", function() {
    it("calculates zoom level", function() {
        const mapViewMock = {
            maxZoomLevel: 20,
            minZoomLevel: 1,
            camera: cameraMock,
            focalLength: 256,
            pixelRatio: 1.0
        };
        const mapView = (mapViewMock as any) as MapView;

        let result = MapViewUtils.calculateZoomLevelFromDistance(0, mapView);
        expect(result).to.be.equal(20);
        result = MapViewUtils.calculateZoomLevelFromDistance(1000000000000, mapView);
        expect(result).to.be.equal(1);
        /*
         *   23.04.2018 - Zoom level outputs come from HARP
         */
        result = MapViewUtils.calculateZoomLevelFromDistance(1000, mapView);
        result = MapViewUtils.calculateZoomLevelFromDistance(10000, mapView);
        result = MapViewUtils.calculateZoomLevelFromDistance(1000000, mapView);
        expect(result).to.be.closeTo(5.32, 0.05);
    });

    it("converts target coordinates from XYZ to camera coordinates", function() {
        const xyzView = {
            zoom: 5,
            yaw: 3,
            pitch: 15,
            center: [10, -10]
        };
        const mapViewMock = {
            camera: cameraMock,
            projection: mercatorProjection,
            focalLength: 256,
            pixelRatio: 1.0
        };
        const mapView = (mapViewMock as any) as MapView;
        const cameraCoordinates = MapViewUtils.getCameraCoordinatesFromTargetCoordinates(
            new GeoCoordinates(xyzView.center[0], xyzView.center[1]),
            xyzView.zoom,
            xyzView.yaw,
            xyzView.pitch,
            mapView
        );
        expect(cameraCoordinates.latitude).to.equal(7.023208311781337);
        expect(cameraCoordinates.longitude).to.equal(-9.842237006382904);
    });

    describe("converts zoom level to height and height to zoom level", function() {
        const distance = 1000;
        let mapViewMock: any;

        beforeEach(function() {
            mapViewMock = {
                maxZoomLevel: 20,
                minZoomLevel: 1,
                camera: cameraMock,
                focalLength: 256,
                pixelRatio: 1.0
            };
        });

        it("ensures that both functions are inverse", function() {
            const zoomLevel = MapViewUtils.calculateZoomLevelFromDistance(distance, {
                ...mapViewMock
            });

            const calculatedHeight = MapViewUtils.calculateDistanceToGroundFromZoomLevel(
                mapViewMock,
                zoomLevel
            );

            expect(distance).to.be.closeTo(calculatedHeight, Math.pow(10, -11));
        });
    });

    it("calculates horizontal and vertical fov", function() {
        const vFov = 60;
        const hFov = MathUtils.radToDeg(
            MapViewUtils.calculateHorizontalFovByVerticalFov(MathUtils.degToRad(vFov), 0.9)
        );
        const calculatedVFov = MathUtils.radToDeg(
            MapViewUtils.calculateVerticalFovByHorizontalFov(MathUtils.degToRad(hFov), 0.9)
        );
        expect(vFov).to.be.closeTo(calculatedVFov, 0.00000000001);
    });

    it("estimate size of world with one cube", async function() {
        const scene: THREE.Scene = new THREE.Scene();
        const geometry = new THREE.BoxGeometry(1, 1, 1);
        const material = new THREE.MeshBasicMaterial({ color: 0x00ff00 });
        const cube = new THREE.Mesh(geometry, material);
        scene.add(cube);

        const objSize = MapViewUtils.estimateObject3dSize(scene);
        expect(objSize.heapSize).to.be.equal(2672);
        expect(objSize.gpuSize).to.be.equal(0);
    });

    it("estimate size of world with one cube (BufferGeometry)", async function() {
        const scene: THREE.Scene = new THREE.Scene();
        const geometry = new THREE.BoxGeometry(1, 1, 1);
        const bufferGeometry = new THREE.BufferGeometry().fromGeometry(geometry);
        const material = new THREE.MeshBasicMaterial({ color: 0x00ff00 });
        const cube = new THREE.Mesh(bufferGeometry, material);
        scene.add(cube);

        const objSize = MapViewUtils.estimateObject3dSize(scene);
        expect(objSize.heapSize).to.be.equal(3808);
        expect(objSize.gpuSize).to.be.equal(1584);
    });

    it("estimate size of world with two cubes that share the geometry", async function() {
        const scene: THREE.Scene = new THREE.Scene();
        const geometry = new THREE.BoxGeometry(1, 1, 1);
        const bufferGeometry = new THREE.BufferGeometry().fromGeometry(geometry);
        const material = new THREE.MeshBasicMaterial({ color: 0x00ff00 });
        const cube0 = new THREE.Mesh(bufferGeometry, material);
        scene.add(cube0);
        const cube1 = new THREE.Mesh(bufferGeometry, material);
        scene.add(cube1);

        const objSize = MapViewUtils.estimateObject3dSize(scene);
        expect(objSize.heapSize).to.be.equal(3808 + 1000); // see previous test
        expect(objSize.gpuSize).to.be.equal(1584); // see previous test
    });

    it("estimate size of world with 1000 cubes (BufferGeometry)", async function() {
        this.timeout(4000);
        const scene: THREE.Scene = new THREE.Scene();
        for (let i = 0; i < 1000; i++) {
            const geometry = new THREE.BoxGeometry(1, 1, 1);
            const bufferGeometry = new THREE.BufferGeometry().fromGeometry(geometry);
            const material = new THREE.MeshBasicMaterial({ color: 0x00ff00 });
            const cube = new THREE.Mesh(bufferGeometry, material);
            scene.add(cube);
        }

        const objSize = MapViewUtils.estimateObject3dSize(scene);
        expect(objSize.heapSize).to.be.equal(3808000);
        expect(objSize.gpuSize).to.be.equal(1584000);
    });
});

describe("tile-offset#Utils", function() {
    it("test getKeyForTileKeyAndOffset and extractOffsetAndMortonKeyFromKey", async function() {
        // This allows 8 offsets to be stored, -4 -> 3, we test also outside this range
        const bitshift = 3;
        const offsets = [-5, -4, -3, -2, -1, 0, 1, 2, 3, 4, 5];
        // Binary is the easist to read, here you can see the -4 -> 3 is mapped to 0 -> 7
        // in the 3 highest bits.
        const results = [
            0b11100000000000000000000000000000000000000000000000001,
            0b00000000000000000000000000000000000000000000000000001,
            0b00100000000000000000000000000000000000000000000000001,
            0b01000000000000000000000000000000000000000000000000001,
            0b01100000000000000000000000000000000000000000000000001,
            0b10000000000000000000000000000000000000000000000000001,
            0b10100000000000000000000000000000000000000000000000001,
            0b11000000000000000000000000000000000000000000000000001,
            0b11100000000000000000000000000000000000000000000000001,
            // Check that we wrap back around to 0
            0b00000000000000000000000000000000000000000000000000001,
            0b00100000000000000000000000000000000000000000000000001
        ];
        const offsetResults = [3, -4, -3, -2, -1, 0, 1, 2, 3, -4, -3];
        const tileKey = TileKey.fromRowColumnLevel(1, 1, 1);
        for (let i = 0; i < offsets.length; i++) {
            const keyByTileKeyAndOffset = TileOffsetUtils.getKeyForTileKeyAndOffset(
                tileKey,
                offsets[i],
                bitshift
            );
            expect(keyByTileKeyAndOffset).to.be.equal(results[i]);

            const { offset, mortonCode } = TileOffsetUtils.extractOffsetAndMortonKeyFromKey(
                keyByTileKeyAndOffset
            );
            expect(offset).to.be.equal(offsetResults[i]);
            expect(mortonCode).to.be.equal(tileKey.mortonCode());
        }
    });
});
