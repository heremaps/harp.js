/*
 * Copyright (C) 2019-2021 HERE Europe B.V.
 * Licensed under Apache 2.0, see full license in LICENSE
 * SPDX-License-Identifier: Apache-2.0
 */
import {
    DecoderOptions,
    ITileDecoder,
    OptionsMap,
    WorkerServiceProtocol
} from "@here/harp-datasource-protocol";
import {
    EarthConstants,
    TileKey,
    TilingScheme,
    webMercatorTilingScheme
} from "@here/harp-geoutils";
import { CopyrightInfo, CopyrightProvider, DataSourceOptions, Tile } from "@here/harp-mapview";
import {
    DataProvider,
    TileDataSource,
    TileDataSourceOptions,
    TileFactory
} from "@here/harp-mapview-decoder";
import { getOptionValue, LoggerManager } from "@here/harp-utils";

import {
    FeatureModifierId,
    OmvDecoderOptions,
    OmvFeatureFilterDescription,
    VECTOR_TILE_DECODER_SERVICE_TYPE
} from "./OmvDecoderDefs";
import {
    APIFormat,
    AuthenticationMethod,
    OmvRestClient,
    OmvRestClientParameters
} from "./OmvRestClient";

const logger = LoggerManager.instance.create("VectorTileDataSource");

export interface VectorTileFactory {
    /** Create an instance of {@link @here/harp-mapview#Tile} or a subclass. */
    createTile(dataSource: VectorTileDataSource, tileKey: TileKey): Tile;
}

export interface VectorTileDataSourceParameters extends DataSourceOptions {
    /**
     * If set to `true`, features that have no technique in the theme will be printed to the console
     * (can be excessive!).
     */
    showMissingTechniques?: boolean;

    /**
     * @deprecated Tile info is not decoded anymore. The same information can be generated
     * implementing a [[IGeometryProcessor]] and using [[OmvProtobufDataAdapter]] to decode OMV
     * data.
     */
    createTileInfo?: boolean;

    /**
     * Specify the decoder that should be used. If not supplied, the default will be used.
     */
    decoder?: ITileDecoder;

    /**
     * Optionally specify the DataProvider that should be used.
     */
    dataProvider?: DataProvider;

    /**
     * Specify the URL to the decoder bundle. If not supplied, the default will be used.
     */
    concurrentDecoderScriptUrl?: string;

    /**
     * Gather feature IDs from `OmvData`. Defaults to `false`.
     * @deprecated FeatureIds are always gathered, use [[gatherFeatureAttributes]] to gather
     * all feature attributes.
     */
    gatherFeatureIds?: boolean;

    /**
     * Gather feature attributes from `OmvData`. Defaults to `false`.
     */
    gatherFeatureAttributes?: boolean;

    /**
     * @deprecated Tile info is not decoded anymore. The same information can be generated
     * implementing a [[IGeometryProcessor]] and using [[OmvProtobufDataAdapter]] to decode OMV
     * data.
     */
    gatherRoadSegments?: boolean;

    /**
     * If not set to `false`, very short text labels will be skipped during decoding based on a
     * heuristic.
     */
    skipShortLabels?: boolean;

    /**
     * A description for the feature filter that can be safely passed down to the web workers.
     *
     * @remarks
     * It has to be generated with the help of the [[OmvFeatureFilterDescriptionBuilder]]
     * (to guarantee correctness). This parameter gets applied to the decoder used in the
     * {@link VectorTileDataSource} which might be shared between
     * various {@link VectorTileDataSource}s.
     */
    filterDescr?: OmvFeatureFilterDescription;

    /**
     * Optional, custom factory for {@link @here/harp-mapview#Tile} instances created
     * by this {@link VectorTileDataSource}.
     */
    tileFactory?: TileFactory<Tile>;

    /**
     * Identifier used to choose [[OmvFeatureModifier]]s to be applied.
     *
     * @remarks
     * If left `undefined` at least [[OmvGenericFeatureModifier]] will be applied.
     * The list of feature modifiers may be extended internally by some data source options
     * such as [[politicalView]] which adds [[OmvPoliticalViewFeatureModifier]].
     *
     * @note This parameter gets applied to the decoder used in the {@link VectorTileDataSource}
     * which might be shared between various {@link VectorTileDataSource}s.
     */
    featureModifierId?: FeatureModifierId;

    /**
     * Expresses specific country point of view that is used when rendering disputed features,
     * like borders, names, etc. If undefined "defacto" or most widely accepted political view
     * will be presented.
     *
     * @see featureModifiers
     */
    politicalView?: string;

    /**
     * Optional, default copyright information of tiles provided by this data source.
     * Implementation should provide this information from the source data if possible.
     */
    copyrightInfo?: CopyrightInfo[];

    /**
     * Optional copyright info provider for tiles provided by this data source.
     */
    copyrightProvider?: CopyrightProvider;

    /**
     * Indicates whether overlay on elevation is enabled. Defaults to `false`.
     */
    enableElevationOverlay?: boolean;

    /**
     * Indicates whether to add a ground plane to cover the tile completely.
     *
     * @remarks
     * This is necessary for the fallback logic, such that the parent fall back tiles don't
     * overlap the children tiles.
     * Default is true (i.e. if not defined it is taken to be true)
     */
    addGroundPlane?: boolean;

    /**
     * Indicates whether the decoder is allowed to adjust the coordinates to
     * avoid possible glitches at the 180th meridian.
     *
     * @defaultValue `true` if the data service is
     *               `https://vector.hereapi.com/v2/vectortiles/base/mc`,
     *               `false` otherwise.
     */
    roundUpCoordinatesIfNeeded?: boolean;
}

/**
 * A helper function to retrieve the [[DataProvider]] from the
 * {@link VectorTileDataSource}s parameters.
 *
 * @param params - The parameters passed into the OmvDataSource.
 */
function getDataProvider(params: OmvWithRestClientParams | OmvWithCustomDataProvider) {
    if ((params as OmvWithCustomDataProvider).dataProvider) {
        return (params as OmvWithCustomDataProvider).dataProvider;
    } else if (
        (params as OmvWithRestClientParams).baseUrl ??
        (params as OmvWithRestClientParams).url
    ) {
        return new OmvRestClient(params as OmvRestClientParameters);
    } else {
        throw new Error("OmvDataSource: missing url, baseUrl or dataProvider params");
    }
}

export type OmvWithRestClientParams = VectorTileDataSourceParameters & OmvRestClientParameters;

export type OmvWithCustomDataProvider = VectorTileDataSourceParameters & {
    dataProvider: DataProvider;
    tilingScheme?: TilingScheme;
};

let missingOmvDecoderServiceInfoEmitted: boolean = false;

/**
 * The default vector tile service.
 */
const hereVectorTileBaseUrl = "https://vector.hereapi.com/v2/vectortiles/base/mc";

/**
 * Default options for the HERE Vector Tile service.
 */
const hereVectorTileDefaultOptions: OmvWithRestClientParams = {
    baseUrl: hereVectorTileBaseUrl,
    apiFormat: APIFormat.XYZOMV,
    styleSetName: "tilezen",
    authenticationMethod: {
        method: AuthenticationMethod.QueryString,
        name: "apikey"
    },
    copyrightInfo: [
        {
            id: "here.com",
            year: new Date().getFullYear(),
            label: "HERE",
            link: "https://legal.here.com/terms"
        }
    ]
};

const defaultOptions = new Map<string, OmvWithRestClientParams>([
    [hereVectorTileBaseUrl, hereVectorTileDefaultOptions]
]);

/**
 * Tests if the given object has custom data provider.
 * @param object -
 */
function hasCustomDataProvider(
    object: Partial<OmvWithCustomDataProvider>
): object is OmvWithCustomDataProvider {
    return object.dataProvider !== undefined;
}

/**
 * Add service specific default values.
 *
 * @param params - The configuration settings of the data source.
 */
function completeDataSourceParameters(
    params: OmvWithRestClientParams | OmvWithCustomDataProvider
): TileDataSourceOptions {
    if (!hasCustomDataProvider(params) && params.url === undefined) {
        const baseUrl = params.baseUrl ?? hereVectorTileBaseUrl;

        const completedParams = {
            ...defaultOptions.get(baseUrl),
            ...params
        };

        return {
            ...completedParams,
            tilingScheme: webMercatorTilingScheme,
            dataProvider: new OmvRestClient(completedParams)
        };
    }

    return {
        tilingScheme: webMercatorTilingScheme,
        ...params,
        dataProvider: getDataProvider(params)
    };
}

/**
 * `VectorTileDataSource` is used for the visualization of vector tiles.
 *
 * @example
 * ```typescript
 *    const dataSource = new VectorTileDataSource({
 *        baseUrl: "https://vector.hereapi.com/v2/vectortiles/base/mc",
 *        authenticationCode: apikey
 *    });
 *    mapView.addDataSource(dataSource);
 *   ```
 */
export class VectorTileDataSource extends TileDataSource {
    private readonly m_decoderOptions: OmvDecoderOptions;

    constructor(private readonly m_params: OmvWithRestClientParams | OmvWithCustomDataProvider) {
        super(m_params.tileFactory ?? new TileFactory(Tile), {
            styleSetName: m_params.styleSetName ?? "omv",
            concurrentDecoderServiceName: VECTOR_TILE_DECODER_SERVICE_TYPE,
            minDataLevel: m_params.minDataLevel ?? 1,
            maxDataLevel: m_params.maxDataLevel ?? 17,
            storageLevelOffset: m_params.storageLevelOffset ?? -1,
            ...completeDataSourceParameters(m_params)
        });

        this.cacheable = true;
        this.addGroundPlane =
            m_params.addGroundPlane === undefined || m_params.addGroundPlane === true;

        let roundUpCoordinatesIfNeeded = m_params.roundUpCoordinatesIfNeeded;

        if (
            roundUpCoordinatesIfNeeded === undefined &&
            (m_params as Partial<OmvWithRestClientParams>)?.baseUrl === hereVectorTileBaseUrl
        ) {
            roundUpCoordinatesIfNeeded = true;
        }

        this.m_decoderOptions = {
            showMissingTechniques: this.m_params.showMissingTechniques === true,
            filterDescription: this.m_params.filterDescr,
            gatherFeatureAttributes: this.m_params.gatherFeatureAttributes === true,
            featureModifiers: this.m_params.featureModifierId
                ? [this.m_params.featureModifierId]
                : undefined,
            politicalView: this.m_params.politicalView,
            skipShortLabels: this.m_params.skipShortLabels,
            storageLevelOffset: m_params.storageLevelOffset ?? -1,
            enableElevationOverlay: this.m_params.enableElevationOverlay === true,
            roundUpCoordinatesIfNeeded
        };

        this.maxGeometryHeight = getOptionValue(
            m_params.maxGeometryHeight,
            EarthConstants.MAX_BUILDING_HEIGHT
        );

        this.minGeometryHeight = getOptionValue(m_params.minGeometryHeight, 0);
    }

    /** @override */
    async connect() {
        try {
            await super.connect();
        } catch (error) {
            // error is a string if the promise was rejected.
            if (
                error.message &&
                WorkerServiceProtocol.isUnknownServiceError(error) &&
                !missingOmvDecoderServiceInfoEmitted
            ) {
                logger.info(
                    "Unable to create decoder service in worker. Use " +
                        " 'OmvTileDecoderService.start();' in decoder script."
                );
                missingOmvDecoderServiceInfoEmitted = true;
            }
            throw typeof error === "string" ? new Error(error) : error;
        }
        this.configureDecoder(undefined, this.m_decoderOptions);
    }

    /**
     * Remove the current data filter.
     * Will be applied to the decoder, which might be shared with other omv datasources.
     */
    removeDataFilter(): void {
        this.configureDecoder(undefined, {
            filterDescription: null
        });
    }

    /**
     * Set a new data filter. Can also be done during
     * the creation of an {@link VectorTileDataSource}.
     * Will be applied to the decoder, which might be shared with other omv datasources.
     *
     * @param filterDescription - Data filter description created with
     * [[OmvFeatureFilterDescriptionBuilder]].
     */
    setDataFilter(filterDescription: OmvFeatureFilterDescription): void {
        this.m_decoderOptions.filterDescription =
            filterDescription !== null ? filterDescription : undefined;

        this.configureDecoder(undefined, {
            filterDescription,
            featureModifiers: this.m_decoderOptions.featureModifiers,
            politicalView: this.m_decoderOptions.politicalView
        });
    }

    /** @override */
    shouldPreloadTiles(): boolean {
        return true;
    }

    /** @override */
    setPoliticalView(politicalView?: string): void {
        // Just in case users mess with letters' casing.
        politicalView = politicalView?.toLowerCase();
        if (this.m_decoderOptions.politicalView !== politicalView) {
            this.m_decoderOptions.politicalView = politicalView;
            this.configureDecoder(undefined, {
                filterDescription: this.m_decoderOptions.filterDescription,
                featureModifiers: this.m_decoderOptions.featureModifiers,
                politicalView: politicalView !== undefined ? politicalView : ""
            });
        }
    }

    /** @override */
    get storageLevelOffset() {
        return super.storageLevelOffset;
    }

    /** @override */
    set storageLevelOffset(levelOffset: number) {
        super.storageLevelOffset = levelOffset;
        this.m_decoderOptions.storageLevelOffset = this.storageLevelOffset;
        this.configureDecoder(undefined, {
            storageLevelOffset: this.storageLevelOffset
        });
    }

    /** @override */
    setEnableElevationOverlay(enable: boolean) {
        if (this.m_decoderOptions.enableElevationOverlay !== enable) {
            this.m_decoderOptions.enableElevationOverlay = enable;
            this.configureDecoder(undefined, {
                enableElevationOverlay: enable
            });
        }
    }

    private configureDecoder(options?: DecoderOptions, customOptions?: OptionsMap) {
        this.clearCache();
        this.decoder.configure(options, customOptions);
        this.mapView.markTilesDirty(this);
    }
}
