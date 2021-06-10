/*
 * Copyright (C) 2019-2021 HERE Europe B.V.
 * Licensed under Apache 2.0, see full license in LICENSE
 * SPDX-License-Identifier: Apache-2.0
 */

import * as THREE from "three";

import { GeoBox } from "../coordinates/GeoBox";
import { GeoCoordinates } from "../coordinates/GeoCoordinates";
import { GeoCoordinatesLike } from "../coordinates/GeoCoordinatesLike";
import { Box3Like, isBox3Like } from "../math/Box3Like";
import { MathUtils } from "../math/MathUtils";
import { isOrientedBox3Like, OrientedBox3Like } from "../math/OrientedBox3Like";
import { Vector3Like } from "../math/Vector3Like";
import { EarthConstants } from "./EarthConstants";
import { Projection, ProjectionType } from "./Projection";

class EquirectangularProjection extends Projection {
    static geoToWorldScale: number = 1.0 / (2.0 * Math.PI);
    static worldToGeoScale: number = (2.0 * Math.PI) / 1.0;

    /** @override */
    readonly type: ProjectionType = ProjectionType.Planar;

    /** @override */
    getScaleFactor(_worldPoint: Vector3Like): number {
        return 1;
    }

    /** @override */
    worldExtent<WorldBoundingBox extends Box3Like>(
        minAltitude: number,
        maxAltitude: number,
        result?: WorldBoundingBox
    ): WorldBoundingBox {
        if (!result) {
            result = (new THREE.Box3() as Box3Like) as WorldBoundingBox;
        }
        result.min.x = 0.0;
        result.min.y = 0.0;
        result.min.z = minAltitude;
        result.max.x = this.unitScale;
        result.max.y = this.unitScale / 2;
        result.max.z = maxAltitude;
        return result;
    }

    /** @override */
    projectPoint<WorldCoordinates extends Vector3Like>(
        geoPoint: GeoCoordinatesLike,
        result?: WorldCoordinates
    ): WorldCoordinates {
        if (result === undefined) {
            result = { x: 0, y: 0, z: 0 } as WorldCoordinates;
        }
        result.x =
            (THREE.MathUtils.degToRad(geoPoint.longitude) + Math.PI) *
            EquirectangularProjection.geoToWorldScale *
            this.unitScale;
        result.y =
            (THREE.MathUtils.degToRad(geoPoint.latitude) + Math.PI * 0.5) *
            EquirectangularProjection.geoToWorldScale *
            this.unitScale;
        result.z = geoPoint.altitude ?? 0;
        return result;
    }

    /** @override */
    unprojectPoint(worldPoint: Vector3Like): GeoCoordinates {
        const geoPoint = GeoCoordinates.fromRadians(
            (worldPoint.y * EquirectangularProjection.worldToGeoScale) / this.unitScale -
                Math.PI * 0.5,
            (worldPoint.x * EquirectangularProjection.worldToGeoScale) / this.unitScale - Math.PI,
            worldPoint.z
        );
        return geoPoint;
    }

    /** @override */
    unprojectAltitude(worldPoint: Vector3Like): number {
        return worldPoint.z;
    }

    /** @override */
    projectBox<WorldBoundingBox extends Box3Like | OrientedBox3Like>(
        geoBox: GeoBox,
        result?: WorldBoundingBox
    ): WorldBoundingBox {
        const worldCenter = this.projectPoint(
            new GeoCoordinates(geoBox.center.latitude, geoBox.center.longitude, 0)
        );
        const { latitudeSpanInRadians, longitudeSpanInRadians, altitudeSpan } = geoBox;
        const sizeX = longitudeSpanInRadians * EquirectangularProjection.geoToWorldScale;
        const sizeY = latitudeSpanInRadians * EquirectangularProjection.geoToWorldScale;
        if (!result) {
            result = (new THREE.Box3() as Box3Like) as WorldBoundingBox;
        }
        if (isBox3Like(result)) {
            result.min.x = worldCenter.x - sizeX * 0.5 * this.unitScale;
            result.min.y = worldCenter.y - sizeY * 0.5 * this.unitScale;
            result.max.x = worldCenter.x + sizeX * 0.5 * this.unitScale;
            result.max.y = worldCenter.y + sizeY * 0.5 * this.unitScale;
            if (altitudeSpan !== undefined) {
                result.min.z = worldCenter.z - altitudeSpan * 0.5;
                result.max.z = worldCenter.z + altitudeSpan * 0.5;
            } else {
                result.min.z = 0;
                result.max.z = 0;
            }
        } else if (isOrientedBox3Like(result)) {
            MathUtils.newVector3(1, 0, 0, result.xAxis);
            MathUtils.newVector3(0, 1, 0, result.yAxis);
            MathUtils.newVector3(0, 0, 1, result.zAxis);
            result.position.x = worldCenter.x;
            result.position.y = worldCenter.y;
            result.position.z = worldCenter.z;
            result.extents.x = sizeX * 0.5 * this.unitScale;
            result.extents.y = sizeY * 0.5 * this.unitScale;
            result.extents.z = Math.max(Number.EPSILON, (altitudeSpan ?? 0) * 0.5);
        }
        return result;
    }

    /** @override */
    unprojectBox(worldBox: Box3Like): GeoBox {
        const minGeo = this.unprojectPoint(worldBox.min);
        const maxGeo = this.unprojectPoint(worldBox.max);
        return GeoBox.fromCoordinates(minGeo, maxGeo);
    }

    /** @override */
    groundDistance(worldPoint: Vector3Like): number {
        return worldPoint.z;
    }

    /** @override */
    scalePointToSurface(worldPoint: Vector3Like): Vector3Like {
        worldPoint.z = 0;
        return worldPoint;
    }

    /** @override */
    surfaceNormal(_worldPoint: Vector3Like, normal?: Vector3Like) {
        if (normal === undefined) {
            normal = { x: 0, y: 0, z: 1 };
        } else {
            normal.x = 0;
            normal.y = 0;
            normal.z = 1;
        }
        return normal;
    }
}

/**
 * Equirectangular {@link Projection} used to convert geo coordinates to unit coordinates and vice
 * versa.
 */
export const normalizedEquirectangularProjection: Projection = new EquirectangularProjection(1);

export const pduEquirectangularProjection: Projection = new EquirectangularProjection(
    Math.pow(2, 32)
);
/**
 * Equirectangular {@link Projection} used to convert geo coordinates to world coordinates and vice
 * versa.
 */
export const equirectangularProjection: Projection = new EquirectangularProjection(
    EarthConstants.EQUATORIAL_CIRCUMFERENCE
);
