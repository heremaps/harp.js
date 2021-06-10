/*
 * Copyright (C) 2019-2021 HERE Europe B.V.
 * Licensed under Apache 2.0, see full license in LICENSE
 * SPDX-License-Identifier: Apache-2.0
 */

import { Definitions, StylePriority, StyleSet } from "./Theme";
import { WorkerServiceProtocol } from "./WorkerServiceProtocol";

/**
 * Interface for `OptionsMap` which describes a general structure of key-value pairs.
 */
export interface OptionsMap {
    [name: string]: any;
}

/**
 * Allows to cancel and prioritize requests inside the requestQueue.
 *
 * @remarks
 * Useful to optimize the order of decoding tiles during animations and camera movements.
 *
 * `RequestController` is not extending [[AbortController]], because this is not supported in ES5.
 */
export class RequestController implements AbortController {
    /**
     * Creates an instance of `RequestController`.
     *
     * @param {number} priority
     * @param {AbortController} abortController Optional [[AbortController]] used internally, since
     *      [[AbortController]]s should not be subclassed.
     */
    constructor(
        public priority: number = 0,
        public abortController: AbortController = new AbortController()
    ) {}

    get signal(): AbortSignal {
        return this.abortController.signal;
    }

    /**
     * Invoking this method will set this object's AbortSignal's aborted flag and
     * signal to any observers that the associated activity is to be aborted.
     */
    abort(): void {
        this.abortController.abort();
    }
}

/**
 * Communication protocol with [[ITileDecoder]].
 */
export namespace WorkerDecoderProtocol {
    /**
     * Define possible names of messages exchanged with decoder services within `WebWorker`.
     */
    export enum DecoderMessageName {
        Configuration = "configuration"
    }

    /**
     * Interface for `DecodedTileMessage` which describes metadata for a decoded tile.
     */
    export interface DecoderMessage {
        service: string;
        type: DecoderMessageName;
    }

    /**
     * Interface for a ConfigurationMessage that is sent from the datasource to the decoder. The
     * message used to configure the [[ITileDecoder]].
     */
    export interface ConfigurationMessage extends DecoderMessage {
        type: DecoderMessageName.Configuration;
        styleSet?: StyleSet;
        definitions?: Definitions;
        priorities?: StylePriority[];
        labelPriorities?: string[];
        options?: OptionsMap;
        languages?: string[];
    }

    /**
     * Type guard to check if an object is an instance of `ConfigurationMessage`.
     */
    export function isConfigurationMessage(message: any): message is ConfigurationMessage {
        return (
            message &&
            typeof message.service === "string" &&
            typeof message.type === "string" &&
            message.type === DecoderMessageName.Configuration
        );
    }

    /**
     * Define possible names of requests called on decoder services within `WebWorker`.
     */
    export enum Requests {
        DecodeTileRequest = "decode-tile-request",
        TileInfoRequest = "tile-info-request"
    }

    /**
     * This object is sent to the decoder asking to decode a specific tile. The expected response
     * type is a [[DecodedTile]].
     */
    export interface DecodeTileRequest extends WorkerServiceProtocol.ServiceRequest {
        type: Requests.DecodeTileRequest;
        tileKey: number;
        data: ArrayBufferLike;
        projection: string;
        tilingScheme?: string;
    }

    /**
     * Type guard to check if an object is a decoded tile object sent to a worker.
     */
    export function isDecodeTileRequest(message: any): message is DecodeTileRequest {
        return (
            message &&
            typeof message.type === "string" &&
            message.type === Requests.DecodeTileRequest
        );
    }

    /**
     * This object is sent to the decoder asking for a tile info of a specific tile. The expected
     * response type is a [[DecodedTile]].
     */
    export interface TileInfoRequest extends WorkerServiceProtocol.ServiceRequest {
        type: Requests.TileInfoRequest;
        tileKey: number;
        data: ArrayBufferLike;
        projection: string;
    }

    /**
     * Type guard to check if an object is an info tile object sent to a worker.
     */
    export function isTileInfoRequest(message: any): message is TileInfoRequest {
        return (
            message && typeof message.type === "string" && message.type === Requests.TileInfoRequest
        );
    }
}
