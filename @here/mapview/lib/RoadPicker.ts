/*
 * Copyright (C) 2018 HERE Global B.V. and its affiliate(s). All rights reserved.
 *
 * This software and other materials contain proprietary information controlled by HERE and are
 * protected by applicable copyright legislation. Any use and utilization of this software and other
 * materials and disclosure to any third parties is conditional upon having a separate agreement
 * with HERE for the access, use, utilization or disclosure of this software. In the absence of such
 * agreement, the use of the software is not allowed.
 */
import { ExtendedTileInfo, getAttributeValue, LineTechnique } from "@here/datasource-protocol";
import { assert, Math2D } from "@here/utils";
import * as THREE from "three";

import { PickObjectType, PickResult } from "./PickHandler";
import { RoadIntersectionData, Tile } from "./Tile";

export interface RoadPickResult extends PickResult {
    distFromCenter: number;
    positions: number[];
}

const MAX_DISTANCE_ERROR = 0.01;

/**
 * Optional flags in the style that can be used to optimize the evaluation.
 */
interface CustomLineTechnique extends LineTechnique {
    isBackground?: boolean;
}

/**
 * The `RoadPicker` class manages picking of roads, which may not be pickable in THREE.js, since
 * their geometry is generated in the vertex shader.
 */
export class RoadPicker {
    /**
     * Register a tile with the `RoadPicker`. Extracts line data from the [[Tile]], but only if it
     * is has the necessary [[ExtendedTileInfo]] that allows the reconstruction of road features.
     *
     * @param tile Loaded tile
     */
    registerTile(tile: Tile): RoadIntersectionData | undefined {
        assert(tile.decodedTile !== undefined);
        if (tile.decodedTile === undefined || tile.decodedTile.tileInfo === undefined) {
            return undefined;
        }
        const extendedTileInfo: ExtendedTileInfo = tile.decodedTile.tileInfo as ExtendedTileInfo;
        const lineFeatures = extendedTileInfo.lineGroup;

        if (lineFeatures === undefined || lineFeatures.numFeatures === 0) {
            // tileInfo not of extepected type [[ExtendedTileInfo]]
            return undefined;
        }

        const widths: number[] = [];
        widths.length = lineFeatures.numFeatures;
        const level = tile.tileKey.level;

        for (let i = 0; i < lineFeatures.numFeatures; i++) {
            const technique = extendedTileInfo.techniqueCatalog[
                lineFeatures.techniqueIndex[i]
            ] as LineTechnique;
            const width = getAttributeValue(technique.lineWidth, level);
            widths[i] = width !== undefined ? Math.max(1, width) : 1;
        }

        const roadIntersectionData = {
            ids: lineFeatures.featureIds,
            techniqueIndex: lineFeatures.techniqueIndex,
            starts: lineFeatures.positionIndex,
            widths,
            positions: lineFeatures.positions,
            techniques: extendedTileInfo.techniqueCatalog
        };

        return roadIntersectionData;
    }

    /**
     * Test for intersection of point `pickPos` with all roads on a tile.
     *
     * @param tile Tile to be picked.
     * @param eyePos WorldPosition of eye (camera) to compute distances.
     * @param pickPos WorldPosition of picked point (on plane).
     * @param results Existing array of [[PickResult]]. New results should be appended.
     */
    intersectRoads(
        tile: Tile,
        eyePos: THREE.Vector3,
        pickPos: THREE.Vector3,
        results: PickResult[]
    ): boolean {
        if (tile.boundingBox.distanceToPoint(pickPos) > MAX_DISTANCE_ERROR) {
            // outside of bounding box of tile
            return false;
        }

        const roadIntersectionData = tile.roadIntersectionData;
        if (roadIntersectionData === undefined) {
            return false;
        }

        const ids = roadIntersectionData.ids;
        const techniques = roadIntersectionData.techniques;
        const techniqueIndices = roadIntersectionData.techniqueIndex;
        const numFeatures = ids.length;
        const positions = roadIntersectionData.positions;
        const widths = roadIntersectionData.widths;
        const px = pickPos.x - tile.center.x;
        const py = pickPos.y - tile.center.y;
        const pickDistance = pickPos.distanceTo(eyePos);

        for (let i = 0; i < numFeatures; i++) {
            const technique = techniques[techniqueIndices[i]] as CustomLineTechnique;

            // if the technique is marked as background or as transient, we ignore it for picking
            if (/*technique.isBackground === true ||*/ technique.transient === true) {
                continue;
            }

            const featureStart = roadIntersectionData.starts[i];
            const featureEnd =
                i < numFeatures - 1
                    ? roadIntersectionData.starts[i + 1]
                    : roadIntersectionData.positions.length;

            let startX = positions[featureStart];
            let startY = positions[featureStart + 1];

            const lineWidthSqr = widths[i] * widths[i];

            let closestDistSqr = Number.MAX_VALUE;

            for (let j = featureStart + 2; j < featureEnd; j += 2) {
                const endX = positions[j];
                const endY = positions[j + 1];

                const distSqr = Math2D.distToSegmentSquared(px, py, startX, startY, endX, endY);
                if (distSqr < lineWidthSqr) {
                    if (distSqr < closestDistSqr) {
                        closestDistSqr = distSqr;
                    }
                }

                startX = endX;
                startY = endY;
            }

            if (closestDistSqr < Number.MAX_VALUE) {
                const roadPickResult: RoadPickResult = {
                    type: PickObjectType.Line,
                    point: pickPos,
                    distance: pickDistance,
                    distFromCenter: Math.sqrt(closestDistSqr),
                    featureId: ids[i],
                    positions: positions.slice(featureStart, featureEnd),
                    technique
                };

                results.push(roadPickResult);
            }
        }

        return false;
    }
}
