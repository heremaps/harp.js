/*
 * Copyright (C) 2017-2019 HERE Europe B.V.
 * Licensed under Apache 2.0, see full license in LICENSE
 * SPDX-License-Identifier: Apache-2.0
 */

import { Expr } from "../Expr";

import { ExprEvaluatorContext, OperatorDescriptorMap } from "../ExprEvaluator";

const operators = {
    "geometry-type": {
        call: (context: ExprEvaluatorContext, args: Expr[]) => {
            const geometryType = context.env.lookup("$geometryType");
            switch (geometryType) {
                case "point":
                    return "Point";
                case "line":
                    return "LineString";
                case "polygon":
                    return "Polygon";
                default:
                    return null;
            }
        }
    }
};

export const FeatureOperators: OperatorDescriptorMap = operators;
export type FeatureOperatorNames = keyof typeof operators;
