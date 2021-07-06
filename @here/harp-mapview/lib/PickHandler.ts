/*
 * Copyright (C) 2019-2021 HERE Europe B.V.
 * Licensed under Apache 2.0, see full license in LICENSE
 * SPDX-License-Identifier: Apache-2.0
 */

import { GeometryType, getFeatureId, Technique } from "@here/harp-datasource-protocol";
import { OrientedBox3, TileKey } from "@here/harp-geoutils";
import * as THREE from "three";

import { IntersectParams } from "./IntersectParams";
import { MapView } from "./MapView";
import { MapViewPoints } from "./MapViewPoints";
import { PickingRaycaster } from "./PickingRaycaster";
import { PickListener } from "./PickListener";
import { Tile, TileFeatureData } from "./Tile";
import { MapViewUtils } from "./Utils";

/**
 * Describes the general type of a picked object.
 */
export enum PickObjectType {
    /**
     * Unspecified.
     */
    Unspecified = 0,

    /**
     * A point object.
     */
    Point,

    /**
     * A line object.
     */
    Line,

    /**
     * An area object.
     */
    Area,

    /**
     * The text part of a {@link TextElement}
     */
    Text,

    /**
     * The Icon of a {@link TextElement}.
     */
    Icon,

    /**
     * Any general 3D object, for example, a landmark.
     */
    Object3D
}

/**
 * A general pick result. You can access the details of a picked geometry from the property
 * `intersection`, which is available if a geometry was hit. If a road was hit, a [[RoadPickResult]]
 * is returned, which has additional information, but no `intersection`.
 */
export interface PickResult {
    /**
     * General type of object.
     */
    type: PickObjectType;

    /**
     * A 2D point in screen coordinates, or a 3D point in world coordinates.
     */
    point: THREE.Vector2 | THREE.Vector3;

    /**
     * Distance from the camera to the picking point; used to determine the closest object.
     */
    distance: number;

    /**
     * Uniquely identifies the data source which provided the picked object.
     */
    dataSourceName: string | undefined;

    /**
     * Data source order, useful for sorting a collection of picking results.
     * A number for objects/features coming from tiles (as those have data sources attached),
     * an undefined when objects are added via "mapView.mapAnchors.add(object)" - those are treated as
     * base layer objects during picking (same as "dataSourceOrder: 0").
     */
    dataSourceOrder: number | undefined;

    /**
     * Render order of the intersected object.
     */
    renderOrder?: number;

    /**
     * An optional feature ID of the picked object.
     * @remarks The ID may be assigned by the object's {@link DataSource}, for example in case of
     * Optimized Map Vector (OMV) and GeoJSON data sources.
     */
    featureId?: number | string;

    /**
     * Defined for geometry only.
     */
    intersection?: THREE.Intersection;

    /**
     * Defined for roads or if `enableTechniqueInfo` option is enabled.
     */
    technique?: Technique;

    /**
     * Optional user data that has been defined in the picked object.
     *
     * @remarks
     * This object points directly to
     * information contained in the original {@link TileFeatureData}
     * stored in {@link MapView}, and should
     * not be modified.
     */
    userData?: any;

    /**
     * The tile key containing the picked object.
     */
    tileKey?: TileKey;
}

const tmpV3 = new THREE.Vector3();
const tmpOBB = new OrientedBox3();

// Intersects the dependent tile objects using the supplied raycaster. Note, because multiple
// tiles can point to the same dependency we need to store which results we have already
// raycasted, see checkedDependencies.
function intersectDependentObjects(
    tile: Tile,
    intersects: THREE.Intersection[],
    rayCaster: THREE.Raycaster,
    checkedDependencies: Set<number>,
    mapView: MapView
) {
    for (const tileKey of tile.dependencies) {
        const mortonCode = tileKey.mortonCode();
        if (checkedDependencies.has(mortonCode)) {
            continue;
        }
        checkedDependencies.add(mortonCode);
        const otherTile = mapView.visibleTileSet.getCachedTile(
            tile.dataSource,
            tileKey,
            tile.offset,
            mapView.frameNumber
        );
        if (otherTile !== undefined) {
            rayCaster.intersectObjects(otherTile.objects, true, intersects);
        }
    }
}

/**
 * Handles the picking of scene geometry and roads.
 * @internal
 */
export class PickHandler {
    private readonly m_pickingRaycaster: PickingRaycaster;

    constructor(
        readonly mapView: MapView,
        readonly camera: THREE.Camera,
        public enablePickTechnique = false
    ) {
        this.m_pickingRaycaster = new PickingRaycaster(
            mapView.renderer.getSize(new THREE.Vector2())
        );
    }

    /**
     * Does a raycast on all objects in the scene; useful for picking.
     *
     * @param x - The X position in CSS/client coordinates, without the applied display ratio.
     * @param y - The Y position in CSS/client coordinates, without the applied display ratio.
     * @param parameters - The intersection test behaviour may be adjusted by providing an instance
     * of {@link IntersectParams}.
     * @returns the list of intersection results.
     */
    intersectMapObjects(x: number, y: number, parameters?: IntersectParams): PickResult[] {
        const ndc = this.mapView.getNormalizedScreenCoordinates(x, y);
        const rayCaster = this.setupRaycaster(x, y);
        const pickListener = new PickListener(parameters);

        if (this.mapView.textElementsRenderer !== undefined) {
            const { clientWidth, clientHeight } = this.mapView.canvas;
            const screenX = ndc.x * clientWidth * 0.5;
            const screenY = ndc.y * clientHeight * 0.5;
            const scenePosition = new THREE.Vector2(screenX, screenY);
            this.mapView.textElementsRenderer.pickTextElements(scenePosition, pickListener);
        }

        const intersects: THREE.Intersection[] = [];
        const intersectedTiles = this.getIntersectedTiles(rayCaster);

        // This ensures that we check a given dependency only once (because multiple tiles could
        // have the same dependency).
        const checkedDependencies = new Set<number>();

        for (const { tile, distance } of intersectedTiles) {
            if (pickListener.done && pickListener.furthestResult!.distance < distance) {
                // Stop when the listener has all results it needs and remaining tiles are further
                // away than then furthest pick result found so far.
                break;
            }

            intersects.length = 0;
            rayCaster.intersectObjects(tile.objects, true, intersects);
            intersectDependentObjects(
                tile,
                intersects,
                rayCaster,
                checkedDependencies,
                this.mapView
            );

            for (const intersect of intersects) {
                pickListener.addResult(this.createResult(intersect, tile));
            }
        }

        // Intersect any objects added by the user.
        intersects.length = 0;
        for (const child of this.mapView.mapAnchors.children) {
            rayCaster.intersectObject(child, true, intersects);

            for (const intersect of intersects) {
                pickListener.addResult(this.createResult(intersect));
            }
        }

        pickListener.finish();
        return pickListener.results;
    }

    /**
     * Returns a ray caster using the supplied screen positions.
     *
     * @param x - The X position in css/client coordinates (without applied display ratio).
     * @param y - The Y position in css/client coordinates (without applied display ratio).
     *
     * @return Raycaster with origin at the camera and direction based on the supplied x / y screen
     * points.
     */
    raycasterFromScreenPoint(x: number, y: number): THREE.Raycaster {
        this.m_pickingRaycaster.setFromCamera(
            this.mapView.getNormalizedScreenCoordinates(x, y),
            this.camera
        );

        this.mapView.renderer.getSize(this.m_pickingRaycaster.canvasSize);
        return this.m_pickingRaycaster;
    }

    private createResult(intersection: THREE.Intersection, tile?: Tile): PickResult {
        const pickResult: PickResult = {
            type: PickObjectType.Unspecified,
            point: intersection.point,
            distance: intersection.distance,
            dataSourceName: intersection.object.userData?.dataSource,
            dataSourceOrder: tile?.dataSource?.dataSourceOrder,
            intersection,
            tileKey: tile?.tileKey
        };

        if (
            intersection.object.userData === undefined ||
            intersection.object.userData.feature === undefined
        ) {
            return pickResult;
        }

        if (this.enablePickTechnique) {
            pickResult.technique = intersection.object.userData.technique;
        }
        pickResult.renderOrder = intersection.object?.renderOrder;

        const featureData: TileFeatureData = intersection.object.userData.feature;
        this.addObjInfo(featureData, intersection, pickResult);
        if (pickResult.userData) {
            const featureId = getFeatureId(pickResult.userData);
            pickResult.featureId = featureId === 0 ? undefined : featureId;
        }

        let pickObjectType: PickObjectType;

        switch (featureData.geometryType) {
            case GeometryType.Point:
            case GeometryType.Text:
                pickObjectType = PickObjectType.Point;
                break;
            case GeometryType.Line:
            case GeometryType.ExtrudedLine:
            case GeometryType.SolidLine:
            case GeometryType.TextPath:
                pickObjectType = PickObjectType.Line;
                break;
            case GeometryType.Polygon:
            case GeometryType.ExtrudedPolygon:
                pickObjectType = PickObjectType.Area;
                break;
            case GeometryType.Object3D:
                pickObjectType = PickObjectType.Object3D;
                break;
            default:
                pickObjectType = PickObjectType.Unspecified;
        }

        pickResult.type = pickObjectType;
        return pickResult;
    }

    private getIntersectedTiles(
        rayCaster: THREE.Raycaster
    ): Array<{ tile: Tile; distance: number }> {
        const tiles = new Array<{
            tile: Tile;
            distance: number;
        }>();
        const tileList = this.mapView.visibleTileSet.dataSourceTileList;
        tileList.forEach(dataSourceTileList => {
            if (!dataSourceTileList.dataSource.enablePicking) {
                return;
            }

            dataSourceTileList.renderedTiles.forEach(tile => {
                tmpOBB.copy(tile.boundingBox);
                tmpOBB.position.sub(this.mapView.worldCenter);
                // This offset shifts the box by the given tile offset, see renderTileObjects in
                // MapView
                const worldOffsetX = tile.computeWorldOffsetX();
                tmpOBB.position.x += worldOffsetX;
                const distance = tmpOBB.intersectsRay(rayCaster.ray);
                if (distance !== undefined) {
                    tiles.push({ tile, distance });
                }
            });
        });

        tiles.sort(
            (lhs: { tile: Tile; distance: number }, rhs: { tile: Tile; distance: number }) => {
                return lhs.distance - rhs.distance;
            }
        );
        return tiles;
    }

    private addObjInfo(
        featureData: TileFeatureData,
        intersect: THREE.Intersection,
        pickResult: PickResult
    ) {
        if (featureData.objInfos === undefined) {
            return;
        }

        if (pickResult.intersection!.object instanceof MapViewPoints) {
            pickResult.userData = featureData.objInfos[intersect.index!];
            return;
        }

        if (
            featureData.starts === undefined ||
            featureData.starts.length === 0 ||
            (typeof intersect.faceIndex !== "number" && intersect.index === undefined)
        ) {
            if (featureData.objInfos.length === 1) {
                pickResult.userData = featureData.objInfos[0];
            }
            return;
        }

        if (featureData.starts.length === 1) {
            pickResult.userData = featureData.objInfos[0];
            return;
        }

        const intersectIndex =
            typeof intersect.faceIndex === "number" ? intersect.faceIndex * 3 : intersect.index!;

        // TODO: Implement binary search.
        let objInfosIndex = 0;
        for (const featureStartIndex of featureData.starts) {
            if (featureStartIndex > intersectIndex) {
                break;
            }
            objInfosIndex++;
        }
        pickResult.userData = featureData.objInfos[objInfosIndex - 1];
    }

    private setupRaycaster(x: number, y: number): THREE.Raycaster {
        const camera = this.mapView.camera;
        const rayCaster = this.raycasterFromScreenPoint(x, y);

        // A threshold must be set for picking of line and line segments, indicating the maximum
        // distance in world units from the ray to a line to consider it as picked. Use the world
        // units equivalent to one pixel at the furthest intersection (i.e. intersection with ground
        // or far plane).
        const furthestIntersection = this.mapView.getWorldPositionAt(x, y, true);
        const furthestDistance =
            camera.position.distanceTo(furthestIntersection) /
            this.mapView.camera.getWorldDirection(tmpV3).dot(rayCaster.ray.direction);
        rayCaster.params.Line!.threshold = MapViewUtils.calculateWorldSizeByFocalLength(
            this.mapView.focalLength,
            furthestDistance,
            1
        );
        return rayCaster;
    }
}
