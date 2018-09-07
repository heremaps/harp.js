/*
 * Copyright (C) 2018 HERE Global B.V. and its affiliate(s). All rights reserved.
 *
 * This software and other materials contain proprietary information controlled by HERE and are
 * protected by applicable copyright legislation. Any use and utilization of this software and other
 * materials and disclosure to any third parties is conditional upon having a separate agreement
 * with HERE for the access, use, utilization or disclosure of this software. In the absence of such
 * agreement, the use of the software is not allowed.
 */

import * as sinon from "sinon";

/**
 * Create stub of global constructor managed by sandbox.
 *
 * A `prototype` preserving, node/browser environment aware version of
 * `sandbox.stub(window | global, name).
 *
 * Use to stub global contstructors like `Worker` or `XMLHttpRequest`.
 *
 * @param sandbox `sinin.Sandbox` instance, required for proper cleanup after test
 * @param name name of global symbol to be constructor
 */
export function stubGlobalConstructor(sandbox: sinon.SinonSandbox, name: string) {
    const theGlobal: any = typeof window !== "undefined" ? window : global;
    let prototype = theGlobal[name].prototype;
    const stub = sandbox.stub(theGlobal, name);
    while (prototype && prototype !== Object.prototype) {
        Object.getOwnPropertyNames(prototype).forEach(key => {
            stub.prototype[key] = sandbox.stub();
        });
        prototype = prototype.__proto__;
    }
    return stub;
}

/**
 * Last error encountered by `willEventually` that forbidden progress in test.
 *
 * Rethrown in [[maybeReportUnmetAssertion]] at the end of test.
 * @hidden
 */
let lastWaitedError: Error | undefined;

/**
 * Internal flag used to in
 * @hidden
 */
let afterHandlerInstalled: boolean = false;

/**
 * Internal - current test instance used by [[willEventually]]
 *
 * @hidden
 */
let mochaCurrentTest: any; // any is used to skip import of whole 'Mocha' for one small typedef

/**
 * Repeats block of code until it passes without `AssertionError`.
 *
 * Additionally, if test fails due to timeout, last error that was encountered is rethrown, so any
 * error that have constructor called `AssertionError` (matches chai assertions) willcause `test` to
 * be repeated after 1ms delay.
 *
 * The last error that blocked `willEventually` from resolving will be rethrown in `afterEach` to
 * mark which assertion didn't hold (see [[reportWillEventuallyBlockingAssertion]]).
 *
 * Use for API's that are internally asynchronous without explicit means to monitor completion of
 * tasks.
 *
 * Example:
 *
 *   const foo = someCodeThatIsAsync({count: 6})
 *
 *   await willEventually(() => {
 *       assert.equals(foo.readyCount, 6);
 *   });
 *
 * @param test closure with assertions that must pass
 * @returns promise that resolves when `test` passes without any error
 */
export function willEventually<T = void>(test: () => T): Promise<T> {
    lastWaitedError = undefined;
    const currentTest = mochaCurrentTest;

    if (!afterHandlerInstalled) {
        afterEach(reportWillEventuallyBlockingAssertion);
        afterHandlerInstalled = true;
    }

    return new Promise<T>((resolve, reject) => {
        function iteration() {
            // Ensure that we're still running out test, because Mocha could abort our test due to
            // timeout or any other reason.
            if (
                currentTest !== mochaCurrentTest ||
                (currentTest !== undefined && currentTest.state !== undefined)
            ) {
                return;
            }
            try {
                const r = test();
                lastWaitedError = undefined;
                resolve(r);
            } catch (error) {
                if (error.constructor.name === "AssertionError") {
                    lastWaitedError = error;
                    setTimeout(iteration, 1);
                } else {
                    lastWaitedError = undefined;
                    reject(error);
                }
            }
        }
        setTimeout(iteration, 1);
    });
}

/**
 * Rethrows last assertion that blocked [[willEventually]] from progress. Called automatically
 * after each `Mocha` test execution when `willEventually` is in use.
 */
export function reportWillEventuallyBlockingAssertion() {
    mochaCurrentTest = undefined;
    if (lastWaitedError) {
        mochaCurrentTest = undefined;
        const tmp = lastWaitedError;
        tmp.message = `willEventually couldn't pass through: ${tmp.toString()}`;
        lastWaitedError = undefined;
        //throw tmp;
    }
    return {};
}

if (typeof beforeEach !== "undefined") {
    beforeEach(function() {
        // Save current test so willEventually can check that current test is still executing.
        mochaCurrentTest = this.currentTest;
    });
}
