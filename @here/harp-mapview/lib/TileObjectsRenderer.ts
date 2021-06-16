/*
 * Copyright (C) 2020-2021 HERE Europe B.V.
 * Licensed under Apache 2.0, see full license in LICENSE
 * SPDX-License-Identifier: Apache-2.0
 */
import {
    Expr,
    getFeatureId,
    getPropertyValue,
    IndexedTechnique,
    MapEnv,
    Pickability
} from "@here/harp-datasource-protocol";

import { BackgroundDataSource } from "./BackgroundDataSource";
import { SolidLineMesh } from "./geometry/SolidLineMesh";
import { MapObjectAdapter } from "./MapObjectAdapter";
import { Tile, TileFeatureData, TileObject } from "./Tile";

const DEFAULT_STENCIL_VALUE = 1;

/*
 * Interface to represent the items of three.js render lists.
 */
interface RenderItem {
    groupOrder: number;
    renderOrder: number;
    program: { id: number };
    material: { id: number };
    z: number;
    id: number;
    object: THREE.Object3D;
}

export class TileObjectRenderer {
    private readonly m_renderOrderStencilValues = new Map<number, number>();
    // Valid values start at 1, because the screen is cleared to zero
    private m_stencilValue: number = DEFAULT_STENCIL_VALUE;

    constructor(private readonly m_env: MapEnv, private readonly m_renderer: THREE.WebGLRenderer) {}

    render(
        tile: Tile,
        storageLevel: number,
        zoomLevel: number,
        cameraPosition: THREE.Vector3,
        rootNode: THREE.Object3D
    ) {
        const worldOffsetX = tile.computeWorldOffsetX();
        if (tile.willRender(storageLevel)) {
            for (const object of tile.objects) {
                const mapObjectAdapter = MapObjectAdapter.get(object);
                if (
                    !this.processTileObject(tile, storageLevel, zoomLevel, object, mapObjectAdapter)
                ) {
                    continue;
                }

                this.updateStencilRef(object);

                object.position.copy(tile.center);
                if (object.displacement !== undefined) {
                    object.position.add(object.displacement);
                }
                object.position.x += worldOffsetX;
                object.position.sub(cameraPosition);
                if (tile.localTangentSpace) {
                    object.setRotationFromMatrix(tile.boundingBox.getRotationMatrix());
                }
                object.frustumCulled = false;

                rootNode.add(object);
            }
            tile.didRender();
        }
    }

    prepareRender() {
        this.m_stencilValue = DEFAULT_STENCIL_VALUE;
        this.m_renderOrderStencilValues.clear();
    }

    /**
     * Prepares the sorting of tile objects.
     */
    setupRenderer() {
        /**
         * Custom sorting function to avoid non-deterministic IBCT testcases. It's basically a copy
         * of the three.js internal sorting, see:
         * https://github.com/mrdoob/three.js/blob/r118/src/renderers/webgl/WebGLRenderLists.js#L5
         * but additionally checking tile-id before checking object.id, material.id and program.id
         * b/c these ids are generated by incrementing a counter. This means if for two test
         * executions the tiles are processed in a different order the ids hence draw call order
         * will also be different.
         */
        const stableSort = (a: RenderItem, b: RenderItem): number => {
            if (a.groupOrder !== b.groupOrder) {
                return a.groupOrder - b.groupOrder;
            } else if (a.renderOrder !== b.renderOrder) {
                return a.renderOrder - b.renderOrder;
            } else if (
                a.object.userData.tileKey &&
                b.object.userData.tileKey &&
                a.object.userData.tileKey.mortonCode() !== b.object.userData.tileKey.mortonCode()
            ) {
                return (
                    a.object.userData.tileKey.mortonCode() - b.object.userData.tileKey.mortonCode()
                );
            } else if (a.program !== b.program) {
                return a.program.id - b.program.id;
            } else if (a.material.id !== b.material.id) {
                return a.material.id - b.material.id;
            } else if (a.z !== b.z) {
                return a.z - b.z;
            } else {
                return a.id - b.id;
            }
        };

        // Custom sorting function which first sorts by the data source order, then by the level,
        // then by the function `stableSort` above.
        const painterSortStable = (a: RenderItem, b: RenderItem): number => {
            const mapObjectAdapterA = MapObjectAdapter.get(a.object);
            const mapObjectAdapterB = MapObjectAdapter.get(b.object);

            const dataSourceOrder = mapObjectAdapterA?.dataSource?.dataSourceOrder;
            const otherDataSourceOrder = mapObjectAdapterB?.dataSource?.dataSourceOrder;
            if (
                // We need to check against undefined because if either is 0, it will evaluate false
                dataSourceOrder !== undefined &&
                otherDataSourceOrder !== undefined &&
                dataSourceOrder !== otherDataSourceOrder
            ) {
                return dataSourceOrder - otherDataSourceOrder;
            }
            // Background data source must be sorted by rendorOrder and not level, otherwise
            // fallback tiles are useless, because they will be covered by this datasource
            if (
                a.renderOrder === BackgroundDataSource.GROUND_RENDER_ORDER ||
                b.renderOrder === BackgroundDataSource.GROUND_RENDER_ORDER
            ) {
                return stableSort(a, b);
            }
            if (mapObjectAdapterA?.level !== undefined && mapObjectAdapterB?.level !== undefined) {
                // Extruded buildings may interfere with landmarks, so we need to sort by
                // renderOrder, see LandmarkDataSource.computeRenderOrder
                const eitherIsBuilding =
                    mapObjectAdapterA.kind?.find(s => s === "building") !== undefined ||
                    mapObjectAdapterB.kind?.find(s => s === "building") !== undefined;
                const sameLevel = mapObjectAdapterA.level === mapObjectAdapterB.level;
                if (sameLevel || eitherIsBuilding) {
                    return stableSort(a, b);
                }
                return mapObjectAdapterA.level - mapObjectAdapterB.level;
            }
            return stableSort(a, b);
        };

        // Temporary workaround due to incorrect comparator type definition:
        // https://github.com/three-types/three-ts-types/issues/41
        this.m_renderer.setOpaqueSort(painterSortStable);
    }

    private updateStencilRef(object: TileObject) {
        // TODO: acquire a new style value of if transparent
        if (object.renderOrder !== undefined && object instanceof SolidLineMesh) {
            const material = object.material;
            if (Array.isArray(material)) {
                material.forEach(
                    mat => (mat.stencilRef = this.getStencilValue(object.renderOrder))
                );
            } else {
                material.stencilRef = this.getStencilValue(object.renderOrder);
            }
        }
    }

    private allocateStencilValue(renderOrder: number) {
        const stencilValue = this.m_stencilValue++;
        this.m_renderOrderStencilValues.set(renderOrder, stencilValue);
        return stencilValue;
    }

    private getStencilValue(renderOrder: number) {
        return (
            this.m_renderOrderStencilValues.get(renderOrder) ??
            this.allocateStencilValue(renderOrder)
        );
    }

    /**
     * Process dynamic updates of [[TileObject]]'s style.
     *
     * @returns `true` if object shall be used in scene, `false` otherwise
     */
    private processTileObject(
        tile: Tile,
        storageLevel: number,
        zoomLevel: number,
        object: TileObject,
        mapObjectAdapter?: MapObjectAdapter
    ) {
        if (!object.visible) {
            return false;
        }
        if (!this.processTileObjectFeatures(tile, storageLevel, zoomLevel, object)) {
            return false;
        }

        if (mapObjectAdapter) {
            mapObjectAdapter.ensureUpdated(tile.mapView);
            if (
                !mapObjectAdapter.isVisible() &&
                !(mapObjectAdapter.pickability === Pickability.all)
            ) {
                return false;
            }
        }
        return true;
    }

    /**
     * Process the features owned by the given `TileObject`.
     *
     * @param tile - The {@link Tile} owning the `TileObject`'s features.
     * @param storageLevel - The storage level of the `Tile` containing the object,
     * @param zoomLevel - The current zoom level of `MapView`.
     * @param object - The `TileObject` to process.
     * @returns `false` if the given `TileObject` should not be added to the scene.
     */
    private processTileObjectFeatures(
        tile: Tile,
        storageLevel: number,
        zoomLevel: number,
        object: TileObject
    ): boolean {
        const technique: IndexedTechnique | undefined = object.userData.technique;

        const minZoomLevel = getPropertyValue(technique?.minZoomLevel, this.m_env);
        const maxZoomLevel = getPropertyValue(technique?.maxZoomLevel, this.m_env);

        if (typeof minZoomLevel === "number" && zoomLevel < minZoomLevel) {
            return false;
        }

        if (typeof maxZoomLevel === "number" && zoomLevel >= maxZoomLevel) {
            return false;
        }

        if (technique?.enabled === undefined) {
            // Nothing to do, there's no technique.
            return true;
        }

        const feature: TileFeatureData = object.userData.feature;

        if (!feature || !Expr.isExpr(technique.enabled)) {
            return Boolean(getPropertyValue(technique.enabled, this.m_env));
        }

        const { starts, objInfos } = feature;

        if (!Array.isArray(objInfos) || !Array.isArray(starts)) {
            // Nothing to do, the object is missing feature ids and their position
            // in the index buffer.
            return true;
        }

        const geometry: THREE.BufferGeometry | undefined = (object as any).geometry;

        if (!geometry || !geometry.isBufferGeometry) {
            // Nothing to do, the geometry is not a [[THREE.BufferGeometry]]
            // and we can't generate groups.
            return true;
        }

        // ExtrudeBufferGeometry for example doesn't have an index, hence we get the final index
        // from the number of vertices.
        const finalIndex = geometry.getIndex()?.count ?? geometry.attributes.position.count;

        // clear the groups.
        geometry.clearGroups();

        // The offset in the index buffer of the end of the last
        // pushed group.
        let endOfLastGroup: number | undefined;

        objInfos.forEach((properties, featureIndex) => {
            // the id of the current feature.
            const featureId = getFeatureId(properties);

            let enabled = true;

            if (Expr.isExpr(technique.enabled)) {
                // the state of current feature.
                const featureState = tile.dataSource.getFeatureState(featureId);

                // create a new {@link @here/harp-datasource-protocol#Env} that can be used
                // to evaluate expressions that access the feature state.
                const $state = featureState ? new MapEnv(featureState) : null;

                const parentEnv =
                    typeof properties === "object"
                        ? new MapEnv(properties, this.m_env)
                        : this.m_env;

                const env = new MapEnv({ $state }, parentEnv);

                enabled = Boolean(getPropertyValue(technique.enabled, env));
            }

            if (!enabled) {
                // skip this feature, it was disabled.
                return;
            }

            // HARP-12247, geometry with no featureStarts would set start to `undefined`, in this
            // case, `endOfLastGroup` is also undefined (first execution in this loop), so it would
            // try to change the count of a group which hasn't yet been added, `addGroup` wasn't yet
            // called, hence we use the `??` operator and fall back to 0. Because featureStarts are
            // optional, we need to have a fallback.
            const start = starts[featureIndex] ?? 0;
            const end = starts[featureIndex + 1] ?? finalIndex;
            const count = end - start;

            if (start === endOfLastGroup) {
                // extend the last group
                geometry.groups[geometry.groups.length - 1].count += count;
            } else {
                geometry.addGroup(start, count);
            }

            endOfLastGroup = start + count;
        });

        return geometry.groups.length > 0;
    }
}
