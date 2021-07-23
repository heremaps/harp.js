/*
 * Copyright (C) 2020-2021 HERE Europe B.V.
 * Licensed under Apache 2.0, see full license in LICENSE
 * SPDX-License-Identifier: Apache-2.0
 */

import { assert } from "@here/harp-utils";

import { IntersectParams } from "./IntersectParams";
import { PickResult } from "./PickHandler";

// Default sorting by:
// 1. reversed data source order (higher first)
// 2. distance to the camera (closer first)
// 3. reversed render order (higher first)
//
// This criteria order is temporary, until HARP-16245 gets implemented.
// Currently, rendering is configured in a way that makes 2D spatials occlude extruded buildings,
// since spatials belong to a higher layer. Picking order reflects that, but comparison by distance should
// happen first, once extruded buildings become rendered on top of spatials.
function defaultSort(lhs: PickResult, rhs: PickResult) {
    // HARP-14531: Compare by "dataSourceOrder" first,
    // to ensure that picking results are sorted according to their layers.
    // The bigger "dataSourceOrder" value is, the higher its stacked in the data model,
    // meaning the higher it should be appear in the resulting picking collection.
    // Defaulting "dataSourceOrder" to 0 (base layer) to not skip comparison when it's undefined - in that case
    // sorting results would not be consistent, as some objects become compared by different criteria.
    const lDataSourceOrder = lhs.dataSourceOrder ?? 0;
    const rDataSourceOrder = rhs.dataSourceOrder ?? 0;
    if (lDataSourceOrder !== rDataSourceOrder) {
        return rDataSourceOrder - lDataSourceOrder;
    }

    // HARP-14553: Set a distance tolerance to ignore small distance differences between 2D objects
    // that are supposed to lie on the same plane.
    const eps = 1e-4;
    const distanceDiff = lhs.distance - rhs.distance;
    const haveRenderOrder = lhs.renderOrder !== undefined && rhs.renderOrder !== undefined;
    if (Math.abs(distanceDiff) > eps || !haveRenderOrder) {
        return distanceDiff;
    }

    return rhs.renderOrder! - lhs.renderOrder!;
}

/**
 * Collects results from a picking (intersection) test.
 *
 * @internal
 */
export class PickListener {
    private m_results: PickResult[] = [];
    private m_sorted: boolean = true;
    private m_finished: boolean = true;

    /**
     * Constructs a new `PickListener`.
     *
     * @param m_parameters - Optional parameters to customize picking behaviour.
     */
    constructor(private readonly m_parameters?: IntersectParams) {}

    /**
     * Adds a pick result.
     *
     * @param result - The result to be added.
     */
    addResult(result: PickResult): void {
        // Add the result only if it's a different feature from the ones already collected.
        const foundFeatureIdx = this.m_results.findIndex(otherResult => {
            const sameType = otherResult.type === result.type;
            const dataSource = result.intersection?.object.userData?.dataSource;
            const sameDataSource =
                dataSource && otherResult.intersection?.object.userData?.dataSource === dataSource;
            const sameId =
                result.featureId !== undefined && otherResult.featureId === result.featureId;
            const noId = result.featureId === undefined && otherResult.featureId === undefined;
            const sameUserData = result.userData && otherResult.userData === result.userData;
            return sameType && sameDataSource && (sameId || (noId && sameUserData));
        });

        if (foundFeatureIdx < 0) {
            this.m_sorted = false;
            this.m_finished = false;
            this.m_results.push(result);
            return;
        }

        // Replace the result for the same feature if it's sorted after the new result.
        const oldResult = this.m_results[foundFeatureIdx];
        if (defaultSort(result, oldResult) < 0) {
            this.m_results[foundFeatureIdx] = result;
            this.m_sorted = false;
            this.m_finished = false;
        }
    }

    /**
     * Indicates whether the listener is satisfied with the results already provided.
     * @returns `True` if the listener doesn't expect more results, `False` otherwise.
     */
    get done(): boolean {
        return this.maxResults ? this.m_results.length >= this.maxResults : false;
    }

    /**
     * Orders the collected results by distance first, then by reversed render order
     * (topmost/highest render order first), and limits the number of results to the maximum
     * accepted number, see {@link IntersectParams.maxResultCount}.
     */
    finish(): void {
        // Keep only the closest max results.
        this.sortResults();
        if (this.maxResults && this.m_results.length > this.maxResults) {
            this.m_results.length = this.maxResults;
        }
        this.m_finished = true;
    }

    /**
     * Returns the collected results. {@link PickListener.finish} should be called first to ensure
     * the proper sorting and result count.
     * @returns The pick results.
     */
    get results(): PickResult[] {
        assert(this.m_finished, "finish() was not called before getting the results");
        return this.m_results;
    }

    /**
     * Returns the closest result collected so far, following the order documented in
     * {@link PickListener.finish}
     * @returns The closest pick result, or `undefined` if no result was collected.
     */
    get closestResult(): PickResult | undefined {
        this.sortResults();
        return this.m_results.length > 0 ? this.m_results[0] : undefined;
    }

    /**
     * Returns the furthest result collected so far, following the order documented in
     * {@link PickListener.results}
     * @returns The furthest pick result, or `undefined` if no result was collected.
     */
    get furthestResult(): PickResult | undefined {
        this.sortResults();
        return this.m_results.length > 0 ? this.m_results[this.m_results.length - 1] : undefined;
    }

    private get maxResults(): number | undefined {
        const maxCount = this.m_parameters?.maxResultCount ?? 0;
        return maxCount > 0 ? maxCount : undefined;
    }

    private sortResults(): void {
        if (this.m_sorted) {
            return;
        }

        // HARP-14531: group zero-distance results first,
        // as screen-space objects (e.g. labels) are currently rendered on top.
        const zeroDistanceGroup: PickResult[] = [];
        const nonZeroDistanceGroup: PickResult[] = [];

        this.m_results
            .sort(defaultSort)
            .forEach(result =>
                (result.distance === 0 ? zeroDistanceGroup : nonZeroDistanceGroup).push(result)
            );
        // both groups are sorted because "this.m_results" are sorted
        this.m_results = zeroDistanceGroup.concat(nonZeroDistanceGroup);
        this.m_sorted = true;
    }
}
