/*
 * Copyright (C) 2020-2021 HERE Europe B.V.
 * Licensed under Apache 2.0, see full license in LICENSE
 * SPDX-License-Identifier: Apache-2.0
 */

//    Mocha discourages using arrow functions, see https://mochajs.org/#arrow-functions
//    Chai uses properties instead of functions for some expect checks.

import { expect } from "chai";
import * as THREE from "three";

import { PickObjectType, PickResult } from "../lib/PickHandler";
import { PickListener } from "../lib/PickListener";

function createIntersection(dataSource: string | undefined): THREE.Intersection {
    const object = new THREE.Object3D();
    object.userData = { dataSource };
    return { distance: 0, point: new THREE.Vector3(), object };
}
describe("PickListener", function () {
    const point = new THREE.Vector3();
    const dataSourceName = "anonymous";
    const dataSourceOrder = 0;

    describe("addResult", function () {
        it("adds all results for new features", function () {
            const listener = new PickListener();
            const userData = {};
            const intersection = createIntersection("ds1");
            listener.addResult({
                type: PickObjectType.Point,
                point,
                distance: 1,
                featureId: 1,
                userData,
                intersection,
                dataSourceName,
                dataSourceOrder
            });

            // different type
            listener.addResult({
                type: PickObjectType.Area,
                point,
                distance: 1,
                featureId: 1,
                userData,
                intersection,
                dataSourceName,
                dataSourceOrder
            });

            // different data source.
            listener.addResult({
                type: PickObjectType.Point,
                point,
                distance: 1,
                featureId: 1,
                userData,
                intersection: createIntersection("ds2"),
                dataSourceName,
                dataSourceOrder
            });

            // different feature id
            listener.addResult({
                type: PickObjectType.Point,
                point,
                distance: 1,
                featureId: 2,
                userData,
                intersection,
                dataSourceName,
                dataSourceOrder
            });

            // no feature id and different user data.
            listener.addResult({
                type: PickObjectType.Point,
                point,
                distance: 1,
                userData: {},
                intersection,
                dataSourceName,
                dataSourceOrder
            });
            listener.finish();
            expect(listener.results).to.have.lengthOf(5);
        });

        it("ignores a result for the same feature of an older closer result", function () {
            const userData = {};
            const intersection = createIntersection("ds1");

            {
                // matching results by feature id.
                const listener = new PickListener();
                const firstResult: PickResult = {
                    type: PickObjectType.Point,
                    point,
                    distance: 1,
                    featureId: 1,
                    userData,
                    intersection,
                    dataSourceName,
                    dataSourceOrder
                };
                listener.addResult(firstResult);

                listener.addResult({
                    type: PickObjectType.Point,
                    point,
                    distance: 2,
                    featureId: 1,
                    intersection,
                    dataSourceName,
                    dataSourceOrder
                });
                listener.finish();

                expect(listener.results).to.have.lengthOf(1);
                expect(listener.results[0]).equals(firstResult);
            }
            {
                // matching results by user data.
                const listener = new PickListener();

                const firstResult: PickResult = {
                    type: PickObjectType.Point,
                    point,
                    distance: 1,
                    userData,
                    intersection,
                    dataSourceName,
                    dataSourceOrder
                };
                listener.addResult(firstResult);

                listener.addResult({
                    type: PickObjectType.Point,
                    point,
                    distance: 2,
                    userData,
                    intersection,
                    dataSourceName,
                    dataSourceOrder
                });
                listener.finish();

                expect(listener.results).to.have.lengthOf(1);
                expect(listener.results[0]).equals(firstResult);
            }
        });

        it("replaces an older result with a closer result for the same feature", function () {
            const listener = new PickListener();
            const userData = {};
            const intersection = createIntersection("ds1");
            listener.addResult({
                type: PickObjectType.Point,
                point,
                distance: 2,
                featureId: 1,
                userData,
                intersection,
                dataSourceName,
                dataSourceOrder
            });

            const closerResult: PickResult = {
                type: PickObjectType.Point,
                point,
                distance: 1,
                featureId: 1,
                intersection,
                dataSourceName,
                dataSourceOrder
            };
            listener.addResult(closerResult);
            listener.finish();

            expect(listener.results).to.have.lengthOf(1);
            expect(listener.results[0]).equals(closerResult);
        });
    });

    describe("finish", function () {
        it("orders the results by 'dataSourceOrder' first, then by 'distance' and 'renderOrder'", function () {
            const expectedResults: PickResult[] = [
                {
                    type: PickObjectType.Point,
                    point,
                    distance: 10,
                    renderOrder: 2,
                    dataSourceName: "layer-2",
                    dataSourceOrder: 2
                },
                {
                    type: PickObjectType.Point,
                    point,
                    distance: 20,
                    renderOrder: 1,
                    dataSourceName: "layer-2",
                    dataSourceOrder: 2
                },
                {
                    type: PickObjectType.Point,
                    point,
                    distance: 5,
                    renderOrder: 3,
                    dataSourceName: "layer-1",
                    dataSourceOrder: 1
                },
                {
                    type: PickObjectType.Point,
                    point,
                    distance: 5,
                    renderOrder: 2,
                    dataSourceName: "layer-1",
                    dataSourceOrder: 1
                }
            ];

            const indexPermutations: number[][] = [
                [0, 1, 2, 3],
                [0, 1, 3, 2],
                [0, 2, 1, 3],
                [0, 2, 3, 1],
                [0, 3, 1, 2],
                [0, 3, 2, 1],
                [1, 0, 2, 3],
                [1, 0, 3, 2],
                [1, 2, 0, 3],
                [1, 2, 3, 0],
                [1, 3, 0, 2],
                [1, 3, 2, 0],
                [2, 0, 1, 3],
                [2, 0, 3, 1],
                [2, 1, 0, 3],
                [2, 1, 3, 0],
                [2, 3, 0, 1],
                [2, 3, 1, 0],
                [3, 0, 1, 2],
                [3, 0, 2, 1],
                [3, 1, 0, 2],
                [3, 1, 2, 0],
                [3, 2, 0, 1],
                [3, 2, 1, 0]
            ];

            indexPermutations.forEach(indexList => {
                const listener = new PickListener();

                indexList.forEach(i => listener.addResult(expectedResults[i]));
                listener.finish();

                expect(
                    listener.results,
                    `input index list: ${JSON.stringify(indexList)}`
                ).to.have.ordered.members(expectedResults);
            });
        });

        it("returns zero-distance (screen-space) results first", function () {
            const listener = new PickListener();
            const expectedResults: PickResult[] = [
                {
                    type: PickObjectType.Point,
                    point,
                    distance: 0,
                    renderOrder: 2,
                    dataSourceName: "layer-2",
                    dataSourceOrder: 2
                },
                {
                    type: PickObjectType.Point,
                    point,
                    distance: 0,
                    renderOrder: 3,
                    dataSourceName: "layer-1",
                    dataSourceOrder: 1
                },
                {
                    type: PickObjectType.Point,
                    point,
                    distance: 24,
                    renderOrder: 20,
                    dataSourceName: "layer-2",
                    dataSourceOrder: 2
                },
                {
                    type: PickObjectType.Point,
                    point,
                    distance: 24,
                    renderOrder: 19,
                    dataSourceName: "layer-2",
                    dataSourceOrder: 2
                },
                {
                    type: PickObjectType.Point,
                    point,
                    distance: 200,
                    renderOrder: 4,
                    dataSourceName: "layer-0",
                    dataSourceOrder: 0
                }
            ];

            listener.addResult(expectedResults[2]);
            listener.addResult(expectedResults[4]);
            listener.addResult(expectedResults[1]);
            listener.addResult(expectedResults[3]);
            listener.addResult(expectedResults[0]);
            listener.finish();

            // 0 and 1 are ranked higher because of 'distance: 0'
            // 0 precedes 1 because of higher 'dataSourceOrder'
            // 2 precedes 3 because of higher 'renderOrder' while 'dataSourceOrder' and 'distance' are same
            // 3 precedes 4 because of higher 'dataSourceOrder'
            expect(listener.results).to.have.ordered.members(expectedResults);
        });

        it("ignores small distance differences for sorting", function () {
            const listener = new PickListener();
            const eps = 1e-6;
            const expectedResults: PickResult[] = [
                {
                    type: PickObjectType.Point,
                    point,
                    distance: 300 + eps,
                    renderOrder: 2,
                    dataSourceName,
                    dataSourceOrder
                },
                {
                    type: PickObjectType.Point,
                    point,
                    distance: 300,
                    renderOrder: 1,
                    dataSourceName,
                    dataSourceOrder
                }
            ];
            listener.addResult(expectedResults[1]);
            listener.addResult(expectedResults[0]);
            listener.finish();

            expect(listener.results).to.have.ordered.members(expectedResults);
        });

        it("keeps only the closest maximum result count if specified", function () {
            const maxResultCount = 1;
            const listener = new PickListener({ maxResultCount });
            const results: PickResult[] = [
                {
                    type: PickObjectType.Point,
                    point,
                    distance: 0,
                    renderOrder: 1,
                    dataSourceName,
                    dataSourceOrder
                },
                {
                    type: PickObjectType.Point,
                    point,
                    distance: 1,
                    renderOrder: 3,
                    dataSourceName,
                    dataSourceOrder
                }
            ];
            listener.addResult(results[1]);
            listener.addResult(results[0]);
            listener.finish();

            expect(listener.results).to.have.lengthOf(maxResultCount);
            expect(listener.results[0]).equals(results[0]);
        });
    });

    describe("closestResult", function () {
        it("returns undefined if there are no results", function () {
            const listener = new PickListener();
            expect(listener.closestResult).to.be.undefined;
        });

        it("returns closest result when there are some results", function () {
            const listener = new PickListener();
            const results: PickResult[] = [
                {
                    type: PickObjectType.Point,
                    point,
                    distance: 0,
                    renderOrder: 1,
                    dataSourceName,
                    dataSourceOrder
                },
                {
                    type: PickObjectType.Point,
                    point,
                    distance: 1,
                    renderOrder: 3,
                    dataSourceName,
                    dataSourceOrder
                }
            ];
            listener.addResult(results[1]);
            listener.addResult(results[0]);
            listener.finish();

            expect(listener.closestResult).to.equal(results[0]);
        });
    });

    describe("furthestResult", function () {
        it("returns undefined if there are no results", function () {
            const listener = new PickListener();
            expect(listener.furthestResult).to.be.undefined;
        });

        it("returns furthest result when there are some results", function () {
            const listener = new PickListener();
            const results: PickResult[] = [
                {
                    type: PickObjectType.Point,
                    point,
                    distance: 0,
                    renderOrder: 1,
                    dataSourceName,
                    dataSourceOrder
                },
                {
                    type: PickObjectType.Point,
                    point,
                    distance: 1,
                    renderOrder: 3,
                    dataSourceName,
                    dataSourceOrder
                }
            ];
            listener.addResult(results[1]);
            listener.addResult(results[0]);
            listener.finish();

            expect(listener.furthestResult).to.equal(results[1]);
        });
    });
});
