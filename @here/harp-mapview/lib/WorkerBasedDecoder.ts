/*
 * Copyright (C) 2019-2021 HERE Europe B.V.
 * Licensed under Apache 2.0, see full license in LICENSE
 * SPDX-License-Identifier: Apache-2.0
 */
import {
    DecodedTile,
    DecoderOptions,
    getProjectionName,
    getTilingSchemeName,
    ITileDecoder,
    OptionsMap,
    RequestController,
    TileInfo,
    WorkerDecoderProtocol,
    WorkerServiceProtocol
} from "@here/harp-datasource-protocol";
import { Projection, TileKey, TilingScheme } from "@here/harp-geoutils";

import { ConcurrentWorkerSet } from "./ConcurrentWorkerSet";

/**
 * Identifier of next decoder worker-service. Used to ensure uniqueness of service ids of decoders
 * dedicated to different datasources.
 */
let nextUniqueServiceId = 0;

/**
 * Decoder based on [[ConcurrentWorkerSet]].
 *
 * Decodes tiles using workers running in separate contexts (also known as `WebWorkers`):
 * - connection establishment,
 * - sends decode requests,
 * - configuration.
 */
export class WorkerBasedDecoder implements ITileDecoder {
    private readonly serviceId: string;
    private m_serviceCreated: boolean = false;

    /**
     * Creates a new `WorkerBasedDecoder`.
     *
     * @param workerSet - [[ConcurrentWorkerSet]] this tiler will live in.
     * @param decoderServiceType - Service type identifier.
     */
    constructor(
        private readonly workerSet: ConcurrentWorkerSet,
        private readonly decoderServiceType: string
    ) {
        this.workerSet.addReference();
        this.serviceId = `${this.decoderServiceType}-${nextUniqueServiceId++}`;
    }

    /**
     * Dispose of dedicated tile decoder services in workers and remove reference to underlying
     * [[ConcurrentWorkerSet]].
     */
    dispose() {
        if (this.m_serviceCreated) {
            this.workerSet
                .broadcastRequest(WorkerServiceProtocol.WORKER_SERVICE_MANAGER_SERVICE_ID, {
                    type: WorkerServiceProtocol.Requests.DestroyService,
                    targetServiceId: this.serviceId
                })
                .catch(() => {
                    /* Ignoring these errors as underlying workers possibly do not exist anymore. */
                });
        }

        this.workerSet.removeReference();
    }

    /**
     * Connects to [[WorkerServiceManager]]s in underlying [[ConcurrentWorkerSet]] and creates
     * dedicated [[TileDecoderService]]s in all workers to serve decode requests.
     */
    async connect(): Promise<void> {
        await this.workerSet.connect(WorkerServiceProtocol.WORKER_SERVICE_MANAGER_SERVICE_ID);
        if (!this.m_serviceCreated) {
            await this.workerSet.broadcastRequest(
                WorkerServiceProtocol.WORKER_SERVICE_MANAGER_SERVICE_ID,
                {
                    type: WorkerServiceProtocol.Requests.CreateService,
                    targetServiceType: this.decoderServiceType,
                    targetServiceId: this.serviceId
                }
            );
            this.m_serviceCreated = true;
        }
    }

    /**
     * Get {@link Tile} from tile decoder service in worker.
     *
     * @remarks
     * Invokes {@link @here/harp-datasource-protocol#DecodeTileRequest} on
     * [[TileDecoderService]] running in worker pool.
     */
    decodeTile(
        data: ArrayBufferLike,
        tileKey: TileKey,
        projection: Projection,
        tilingScheme: TilingScheme,
        requestController?: RequestController
    ): Promise<DecodedTile> {
        const tileKeyCode = tileKey.mortonCode();

        const message: WorkerDecoderProtocol.DecodeTileRequest = {
            type: WorkerDecoderProtocol.Requests.DecodeTileRequest,
            tileKey: tileKeyCode,
            data,
            projection: getProjectionName(projection),
            tilingScheme: getTilingSchemeName(tilingScheme)
        };

        const transferList = data instanceof ArrayBuffer ? [data] : undefined;

        return this.workerSet.invokeRequest(
            this.serviceId,
            message,
            transferList,
            requestController
        );
    }

    /**
     * Get {@link @here/harp-datasource-protocol#TileInfo} from tile decoder service in worker.
     *
     * @remarks
     * Invokes {@link @here/harp-datasource-protocol#TileInfoRequest}
     * on [[TileDecoderService]] running in worker pool.
     */
    getTileInfo(
        data: ArrayBufferLike,
        tileKey: TileKey,
        projection: Projection,
        requestController?: RequestController
    ): Promise<TileInfo | undefined> {
        const tileKeyCode = tileKey.mortonCode();

        const message: WorkerDecoderProtocol.TileInfoRequest = {
            type: WorkerDecoderProtocol.Requests.TileInfoRequest,
            tileKey: tileKeyCode,
            data,
            projection: getProjectionName(projection)
        };

        const transferList = data instanceof ArrayBuffer ? [data] : undefined;
        return this.workerSet.invokeRequest(
            this.serviceId,
            message,
            transferList,
            requestController
        );
    }

    /**
     * Configure tile decoder service in workers.
     *
     * @remarks
     * Broadcasts {@link @here/harp-datasource-protocol#ConfigurationMessage}
     * to all [[TileDecoderService]]s running in worker pool.
     *
     * @param options - Options that will be applied to the styles
     * @param customOptions -   new options, undefined options are not changed
     */
    configure(options?: DecoderOptions, customOptions?: OptionsMap): void {
        const message: WorkerDecoderProtocol.ConfigurationMessage = {
            service: this.serviceId,
            type: WorkerDecoderProtocol.DecoderMessageName.Configuration,
            ...options,
            options: customOptions
        };

        this.workerSet.broadcastMessage(message);
    }

    /**
     * The number of workers started for this decoder. The value is `undefined` until the workers
     * have been created.
     */
    get workerCount(): number | undefined {
        return this.workerSet.workerCount;
    }
}
