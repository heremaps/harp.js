/*
 * Copyright (C) 2019-2021 HERE Europe B.V.
 * Licensed under Apache 2.0, see full license in LICENSE
 * SPDX-License-Identifier: Apache-2.0
 */
import "@here/harp-fetch";

import {
    DecodedTile,
    ITileDecoder,
    RequestController,
    TileInfo
} from "@here/harp-datasource-protocol";
import { TileKey } from "@here/harp-geoutils";
import { BaseTileLoader, DataSource } from "@here/harp-mapview";
import { TileLoaderState } from "@here/harp-mapview/lib/ITileLoader";
import { LoggerManager } from "@here/harp-utils";

import { DataProvider } from "./DataProvider";

/**
 * Logger to write to console etc.
 */
const logger = LoggerManager.instance.create("TileLoader");

/**
 * The [[TileLoader]] manages the different states of loading and decoding for a [[Tile]]. Used by
 * the [[TileDataSource]].
 */
export class TileLoader extends BaseTileLoader {
    /**
     * The binary data in form of [[ArrayBufferLike]], or any object.
     */
    payload?: ArrayBufferLike | {};

    /**
     * The result of decoding the `payload`: The [[DecodedTile]].
     */
    decodedTile?: DecodedTile;

    /**
     * The  notifying the [[ITileDecoder]] to cancel decoding.
     */
    protected requestController?: RequestController;

    /**
     * Set up loading of a single [[Tile]].
     *
     * @param dataSource - The [[DataSource]] the tile belongs to.
     * @param tileKey - The quadtree address of a [[Tile]].
     * @param dataProvider - The [[DataProvider]] that retrieves the binary tile data.
     * @param tileDecoder - The [[ITileDecoder]] that decodes the binary tile to a [[DecodeTile]].
     */
    constructor(
        protected dataSource: DataSource,
        protected tileKey: TileKey,
        protected dataProvider: DataProvider,
        protected tileDecoder: ITileDecoder
    ) {
        super(dataSource, tileKey);
    }

    /**
     * @override
     */
    get priority(): number {
        return this.m_priority;
    }

    /**
     * @override
     */
    set priority(priority: number) {
        this.m_priority = priority;
        if (this.requestController !== undefined) {
            this.requestController.priority = priority;
        }
    }

    /**
     * @override
     */
    protected loadImpl(
        abortSignal: AbortSignal,
        onDone: (doneState: TileLoaderState) => void,
        onError: (error: Error) => void
    ): void {
        this.dataProvider
            .getTile(this.tileKey, abortSignal)
            .then(payload => {
                if (abortSignal.aborted) {
                    // safety belt if getTile doesn't really support cancellation tokens
                    const err = new Error("Aborted");
                    err.name = "AbortError";
                    throw err;
                }
                this.onLoaded(payload, onDone, onError);
            })
            .catch(error => {
                // Handle abort messages from fetch and also our own.
                if (error.name === "AbortError" || error.message === "AbortError: Aborted") {
                    return;
                }
                onError(error);
            });
    }

    /**
     * @override
     */
    protected cancelImpl(): void {
        if (this.state === TileLoaderState.Decoding && this.requestController) {
            // we should cancel any decodes already in progress!
            this.requestController.abort();
            this.requestController = undefined;
        }
    }

    /**
     * Start decoding the payload.
     */
    protected startDecodeTile(
        onDone: (doneState: TileLoaderState) => void,
        onError: (error: Error) => void
    ) {
        const payload = this.payload;
        if (payload === undefined) {
            logger.error("TileLoader#startDecodeTile: Cannot decode without payload");
            return;
        }

        this.state = TileLoaderState.Decoding;
        this.payload = undefined;

        // Save our cancellation point, so we can be reliably cancelled by any subsequent decode
        // attempts
        const requestController = new RequestController(this.priority);
        this.requestController = requestController;

        const dataSource = this.dataSource;
        this.tileDecoder
            .decodeTile(
                payload,
                this.tileKey,
                dataSource.projection,
                dataSource.getTilingScheme(),
                requestController
            )
            .then(decodedTile => {
                if (requestController.signal.aborted) {
                    // our flow is cancelled, silently return
                    return;
                }

                this.onDecoded(decodedTile, onDone);
            })
            .catch(error => {
                // Handle abort messages from fetch and also our own.
                if (error.name === "AbortError" || error.message === "AbortError: Aborted") {
                    // our flow is cancelled, silently return
                    return;
                }
                onError(error);
            });
    }

    /**
     * Called when binary data has been loaded. The loading state is now progressing to decoding.
     *
     * @param payload - Binary data in form of [[ArrayBufferLike]], or any object.
     */
    private onLoaded(
        payload: ArrayBufferLike | {},
        onDone: (doneState: TileLoaderState) => void,
        onError: (error: Error) => void
    ) {
        this.state = TileLoaderState.Loaded;
        this.payload = payload;

        const byteLength = (payload as ArrayBufferLike).byteLength;
        if (
            byteLength === 0 ||
            (payload.constructor === Object && Object.keys(payload).length === 0)
        ) {
            // Object is empty
            this.onDecoded(
                {
                    geometries: [],
                    techniques: []
                },
                onDone
            );
            return;
        }

        // TBD: we might suspend decode if tile is not visible ... ?
        this.startDecodeTile(onDone, onError);
    }

    /**
     * Called when the decoding is finished, and the [[DecodedTile]] has been created.
     *
     * @param decodedTile - The [[DecodedTile]].
     */
    private onDecoded(
        decodedTile: DecodedTile | undefined,
        onDone: (doneState: TileLoaderState) => void
    ) {
        this.decodedTile = decodedTile;
        onDone(TileLoaderState.Ready);
    }
}

/**
 * Subclass of [[TileLoader]] which is used by [[TileDataSource]] to load the [[TileInfo]] meta
 * data, not the tile data itself.
 */
export class TileInfoLoader extends TileLoader {
    tileInfo?: TileInfo;

    /** @override */
    protected startDecodeTile(
        onDone: (doneState: TileLoaderState) => void,
        onError: (error: Error) => void
    ) {
        const payload = this.payload;
        if (payload === undefined) {
            logger.error("TileInfoLoader#startDecodeTile: Cannot decode without payload");
            return;
        }

        this.state = TileLoaderState.Decoding;
        this.payload = undefined;

        // Save our cancellation point, so we can be reliably cancelled by any subsequent decode
        // attempts
        const requestController = new RequestController(this.priority);
        this.requestController = requestController;

        const dataSource = this.dataSource;
        this.tileDecoder
            .getTileInfo(payload, this.tileKey, dataSource.projection, requestController)
            .then(tileInfo => {
                if (requestController.signal.aborted) {
                    // our flow is cancelled, silently return
                    return;
                }
                this.tileInfo = tileInfo;

                onDone(TileLoaderState.Ready);
            })
            .catch(error => {
                // Handle abort messages from fetch and also our own.
                if (error.name === "AbortError" || error.message === "AbortError: Aborted") {
                    // our flow is cancelled, silently return
                    return;
                }
                onError(error);
            });
    }
}
