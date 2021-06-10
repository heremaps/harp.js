/*
 * Copyright (C) 2019-2021 HERE Europe B.V.
 * Licensed under Apache 2.0, see full license in LICENSE
 * SPDX-License-Identifier: Apache-2.0
 */
import {
    DecodedTile,
    DecoderOptions,
    ITileDecoder,
    OptionsMap,
    TileInfo
} from "@here/harp-datasource-protocol";
import { StyleSetEvaluator, StyleSetOptions } from "@here/harp-datasource-protocol/index-decoder";
import { Projection, TileKey, TilingScheme, webMercatorTilingScheme } from "@here/harp-geoutils";
import { LoggerManager } from "@here/harp-utils";

const logger = LoggerManager.instance.create("ThemedTileDecoder");

/**
 * `ThemedTileDecoder` implements an [[ITileDecoder]] which uses a [[Theme]] to apply styles to the
 * objects displayed in the map.
 *
 * By default, decoders are executed in web workers (using [[TileDecoderService]]) for performance
 * reasons.
 */
export abstract class ThemedTileDecoder implements ITileDecoder {
    languages?: string[];
    m_storageLevelOffset: number = 0;

    protected m_styleSetEvaluator?: StyleSetEvaluator;
    abstract connect(): Promise<void>;

    dispose() {
        // implemented in subclasses
    }

    decodeTile(
        data: ArrayBufferLike,
        tileKey: TileKey,
        projection: Projection,
        tilingScheme: TilingScheme = webMercatorTilingScheme
    ): Promise<DecodedTile | undefined> {
        if (this.m_styleSetEvaluator === undefined) {
            logger.info("cannot decode tile, as there is not style available");
            return Promise.resolve(undefined);
        }

        return this.decodeThemedTile(
            data,
            tileKey,
            this.m_styleSetEvaluator,
            projection,
            tilingScheme
        );
    }

    getTileInfo(
        data: ArrayBufferLike,
        tileKey: TileKey,
        projection: Projection
    ): Promise<TileInfo | undefined> {
        return Promise.resolve(undefined);
    }

    configure(options?: DecoderOptions, customOptions?: OptionsMap): void {
        if (options?.styleSet !== undefined) {
            this.m_styleSetEvaluator = new StyleSetEvaluator(options as StyleSetOptions);
        }
        if (options?.languages !== undefined) {
            this.languages = options.languages;
        }
        if (customOptions !== undefined && customOptions.storageLevelOffset !== undefined) {
            this.m_storageLevelOffset = customOptions.storageLevelOffset;
        }
    }

    /**
     * Create a [[DecodedTile]] from binary tile data and a theme description in form of a
     * [[StyleSetEvaluator]].
     *
     * @param data - Binary data in form of [[ArrayBufferLike]], or any object.
     * @param tileKey - Quadtree address of tile.
     * @param styleSetEvaluator - Processor of [[Theme]], identifies styling techniques applicable
     *                            to individual objects.
     * @param projection - Projection used by the individual data sources.
     */
    abstract decodeThemedTile(
        data: ArrayBufferLike | {},
        tileKey: TileKey,
        styleSetEvaluator: StyleSetEvaluator,
        projection: Projection,
        tilingScheme: TilingScheme
    ): Promise<DecodedTile>;
}
