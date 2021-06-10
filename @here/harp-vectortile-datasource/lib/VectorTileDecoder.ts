/*
 * Copyright (C) 2019-2021 HERE Europe B.V.
 * Licensed under Apache 2.0, see full license in LICENSE
 * SPDX-License-Identifier: Apache-2.0
 */
import {
    DecodedTile,
    DecoderOptions,
    GeometryKind,
    IndexedTechnique,
    OptionsMap
} from "@here/harp-datasource-protocol";
import { MapEnv, StyleSetEvaluator } from "@here/harp-datasource-protocol/index-decoder";
import { AttrEvaluationContext } from "@here/harp-datasource-protocol/lib/TechniqueAttr";
import { Projection, TileKey, TilingScheme, webMercatorTilingScheme } from "@here/harp-geoutils";
import {
    ThemedTileDecoder,
    TileDecoderService,
    WorkerServiceManager
} from "@here/harp-mapview-decoder/index-worker";
import { assert, LoggerManager, PerformanceTimer } from "@here/harp-utils";
import * as THREE from "three";

import { GeoJsonDataAdapter } from "./adapters/geojson/GeoJsonDataAdapter";
import { GeoJsonVtDataAdapter } from "./adapters/geojson-vt/GeoJsonVtDataAdapter";
import { OcmDataAdapter } from "./adapters/ocm/OcmDataAdapter";
import { OmvDataAdapter } from "./adapters/omv/OmvDataAdapter";
import { DataAdapter } from "./DataAdapter";
import { DecodeInfo } from "./DecodeInfo";
import { IGeometryProcessor, ILineGeometry, IPolygonGeometry } from "./IGeometryProcessor";
import {
    ComposedDataFilter,
    OmvFeatureFilter,
    OmvFeatureModifier,
    OmvGenericFeatureFilter,
    OmvGenericFeatureModifier
} from "./OmvDataFilter";
import {
    FeatureModifierId,
    OmvDecoderOptions,
    OmvFeatureFilterDescription,
    VECTOR_TILE_DECODER_SERVICE_TYPE
} from "./OmvDecoderDefs";
import { OmvPoliticalViewFeatureModifier } from "./OmvPoliticalViewFeatureModifier";
import { StyleSetDataFilter } from "./StyleSetDataFilter";
import { VectorTileDataEmitter } from "./VectorTileDataEmitter";

const logger = LoggerManager.instance.create("VectorTileDecoder", { enabled: false });

export class VectorTileDataProcessor implements IGeometryProcessor {
    // The emitter is optional now.
    // TODO: Add option to control emitter generation.
    private m_decodedTileEmitter: VectorTileDataEmitter | undefined;
    private readonly m_dataAdapters: DataAdapter[] = [];

    constructor(
        private readonly m_projection: Projection,
        private readonly m_styleSetEvaluator: StyleSetEvaluator,
        private readonly m_showMissingTechniques: boolean,
        private readonly m_dataFilter?: OmvFeatureFilter,
        private readonly m_featureModifiers?: OmvFeatureModifier[],
        private readonly m_tilingScheme: TilingScheme = webMercatorTilingScheme,
        private readonly m_gatherFeatureAttributes = false,
        private readonly m_skipShortLabels = true,
        private readonly m_storageLevelOffset = 0,
        private readonly m_enableElevationOverlay = false,
        private readonly m_roundUpCoordinatesIfNeeded = false,
        private readonly m_languages?: string[]
    ) {
        const styleSetDataFilter = new StyleSetDataFilter(m_styleSetEvaluator);
        const dataPreFilter = m_dataFilter
            ? new ComposedDataFilter([styleSetDataFilter, m_dataFilter])
            : styleSetDataFilter;

        // Register the default adapters.

        const omvDataAdapter = new OmvDataAdapter(this, dataPreFilter, logger);
        omvDataAdapter.roundUpCoordinatesIfNeeded = m_roundUpCoordinatesIfNeeded;
        this.m_dataAdapters.push(omvDataAdapter);

        this.m_dataAdapters.push(new GeoJsonVtDataAdapter(this, dataPreFilter, logger));
        this.m_dataAdapters.push(new GeoJsonDataAdapter(this, dataPreFilter, logger));
        this.m_dataAdapters.push(new OcmDataAdapter(this, logger));
    }

    get storageLevelOffset() {
        return this.m_storageLevelOffset;
    }

    /**
     * Given a tile and a protobuffer, it returns a decoded tile and it creates the geometries that
     * belong to it.
     *
     * @param tileKey - The tile to be decoded.
     * @param data - The protobuffer to decode from.
     * @returns A [[DecodedTile]]
     */
    getDecodedTile(tileKey: TileKey, data: ArrayBufferLike | {}): DecodedTile {
        let dataAdapter;
        for (const adapter of this.m_dataAdapters.values()) {
            if (adapter.canProcess(data)) {
                dataAdapter = adapter;
                break;
            }
        }
        if (dataAdapter === undefined) {
            return {
                techniques: [],
                geometries: []
            };
        }

        this.m_styleSetEvaluator.resetTechniques();

        const decodeInfo = new DecodeInfo(
            dataAdapter.id,
            this.m_projection,
            tileKey,
            this.m_tilingScheme,
            this.m_storageLevelOffset
        );

        this.m_decodedTileEmitter = new VectorTileDataEmitter(
            decodeInfo,
            this.m_styleSetEvaluator,
            this.m_gatherFeatureAttributes,
            this.m_skipShortLabels,
            this.m_enableElevationOverlay,
            this.m_languages
        );

        dataAdapter.process(data, decodeInfo);
        return this.m_decodedTileEmitter.getDecodedTile();
    }

    /** @override */
    processPointFeature(
        layer: string,
        extents: number,
        geometry: THREE.Vector3[],
        env: MapEnv,
        storageLevel: number
    ): void {
        if (this.m_featureModifiers !== undefined) {
            if (
                this.m_featureModifiers.find(fm => {
                    // TODO: The logic of feature ignore should be actually in the feature filtering
                    // mechanism - see OmvFeatureFilter.
                    return !fm.doProcessPointFeature(layer, env, storageLevel);
                }) !== undefined
            ) {
                return;
            }
        }

        const techniques = this.applyKindFilter(
            this.m_styleSetEvaluator.getMatchingTechniques(env, layer, "point"),
            GeometryKind.Label
        );

        if (techniques.length === 0) {
            if (this.m_showMissingTechniques) {
                logger.log(
                    "OmvDecoder#processPointFeature: no techniques for object:",
                    JSON.stringify(env.unmap())
                );
            }
            return;
        }
        const context: AttrEvaluationContext = {
            env,
            cachedExprResults: new Map()
        };

        if (this.m_decodedTileEmitter) {
            this.m_decodedTileEmitter.processPointFeature(
                layer,
                extents,
                geometry,
                context,
                techniques
            );
        }
    }

    /** @override */
    processLineFeature(
        layer: string,
        extents: number,
        geometry: ILineGeometry[],
        env: MapEnv,
        storageLevel: number
    ): void {
        if (this.m_featureModifiers !== undefined) {
            if (
                this.m_featureModifiers.find(fm => {
                    return !fm.doProcessLineFeature(layer, env, storageLevel);
                }) !== undefined
            ) {
                return;
            }
        }

        const techniques = this.applyKindFilter(
            this.m_styleSetEvaluator.getMatchingTechniques(env, layer, "line"),
            GeometryKind.Line
        );

        if (techniques.length === 0) {
            if (this.m_showMissingTechniques) {
                logger.log(
                    "OmvDecoder#processLineFeature: no techniques for object:",
                    JSON.stringify(env.unmap())
                );
            }
            return;
        }

        const context: AttrEvaluationContext = {
            env,
            cachedExprResults: new Map()
        };

        if (this.m_decodedTileEmitter) {
            this.m_decodedTileEmitter.processLineFeature(
                layer,
                extents,
                geometry,
                context,
                techniques
            );
        }
    }

    /** @override */
    processPolygonFeature(
        layer: string,
        extents: number,
        geometry: IPolygonGeometry[],
        env: MapEnv,
        storageLevel: number
    ): void {
        if (this.m_featureModifiers !== undefined) {
            if (
                this.m_featureModifiers.find(fm => {
                    return !fm.doProcessPolygonFeature(layer, env, storageLevel);
                }) !== undefined
            ) {
                return;
            }
        }

        const techniques = this.applyKindFilter(
            this.m_styleSetEvaluator.getMatchingTechniques(env, layer, "polygon"),
            GeometryKind.Area
        );

        if (techniques.length === 0) {
            if (this.m_showMissingTechniques) {
                logger.log(
                    "OmvDecoder#processPolygonFeature: no techniques for object:",
                    JSON.stringify(env.unmap())
                );
            }
            return;
        }

        const context = {
            env,
            cachedExprResults: new Map()
        };

        if (this.m_decodedTileEmitter) {
            this.m_decodedTileEmitter.processPolygonFeature(
                layer,
                extents,
                geometry,
                context,
                techniques
            );
        }
    }

    private applyKindFilter(
        techniques: IndexedTechnique[],
        defaultKind: GeometryKind
    ): IndexedTechnique[] {
        if (this.m_dataFilter !== undefined && this.m_dataFilter.hasKindFilter) {
            techniques = techniques.filter(technique => {
                const kind =
                    technique.kind === undefined ? defaultKind : (technique.kind as GeometryKind);
                return this.m_dataFilter!.wantsKind(kind);
            });
        }
        return techniques;
    }
}

/**
 * The vector tile decoder.
 */
export class VectorTileDecoder extends ThemedTileDecoder {
    private m_showMissingTechniques: boolean = false;
    private m_featureFilter?: OmvFeatureFilter;
    private m_featureModifiers?: OmvFeatureModifier[];
    private m_gatherFeatureAttributes: boolean = false;
    private m_skipShortLabels: boolean = true;
    private m_enableElevationOverlay: boolean = false;
    private m_roundUpCoordinatesIfNeeded: boolean = false;

    /** @override */
    connect(): Promise<void> {
        return Promise.resolve();
    }

    /** @override */
    decodeThemedTile(
        data: ArrayBufferLike,
        tileKey: TileKey,
        styleSetEvaluator: StyleSetEvaluator,
        projection: Projection,
        tilingScheme: TilingScheme
    ): Promise<DecodedTile> {
        const startTime = PerformanceTimer.now();

        const decoder = new VectorTileDataProcessor(
            projection,
            styleSetEvaluator,
            this.m_showMissingTechniques,
            this.m_featureFilter,
            this.m_featureModifiers,
            tilingScheme,
            this.m_gatherFeatureAttributes,
            this.m_skipShortLabels,
            this.m_storageLevelOffset,
            this.m_enableElevationOverlay,
            this.m_roundUpCoordinatesIfNeeded,
            this.languages
        );

        const decodedTile = decoder.getDecodedTile(tileKey, data);

        decodedTile.decodeTime = PerformanceTimer.now() - startTime;

        return Promise.resolve(decodedTile);
    }

    /** @override */
    configure(options?: DecoderOptions, customOptions?: OptionsMap): void {
        super.configure(options, customOptions);

        if (customOptions) {
            const omvOptions = customOptions as OmvDecoderOptions;

            if (omvOptions.showMissingTechniques !== undefined) {
                this.m_showMissingTechniques = omvOptions.showMissingTechniques === true;
            }

            if (omvOptions.filterDescription !== undefined) {
                if (omvOptions.filterDescription !== null) {
                    // TODO: Feature modifier is always used only with feature filter.
                    // At best the filtering feature should be excluded from other feature
                    // modifiers and be performed solely via OmvGenericFeature modifier or filter.
                    const filterDescription = omvOptions.filterDescription;
                    const featureModifiersIds = omvOptions.featureModifiers;

                    // Create new filter from description.
                    this.m_featureFilter = new OmvGenericFeatureFilter(filterDescription);
                    // Create feature modifiers.
                    const featureModifiers: OmvFeatureModifier[] = [];
                    if (featureModifiersIds !== undefined) {
                        featureModifiersIds.forEach(fmId => {
                            featureModifiers.push(
                                this.createFeatureModifier(filterDescription, fmId)
                            );
                        });
                    } else {
                        featureModifiers.push(
                            this.createFeatureModifier(filterDescription, FeatureModifierId.default)
                        );
                    }
                    this.m_featureModifiers = featureModifiers;
                } else {
                    // null is the signal to clear the filter/modifier
                    this.m_featureFilter = undefined;
                    this.m_featureModifiers = undefined;
                }
            }

            if (omvOptions.politicalView !== undefined) {
                const politicalView = omvOptions.politicalView;
                let featureModifiers = this.m_featureModifiers;
                // Remove existing political view modifiers, this actually setups default,
                // commonly accepted point of view - without feature modifier.
                if (featureModifiers) {
                    featureModifiers = featureModifiers.filter(
                        fm => !(fm instanceof OmvPoliticalViewFeatureModifier)
                    );
                }
                // If political view is indeed requested append feature modifier at the end of list.
                if (politicalView.length !== 0) {
                    assert(
                        politicalView.length === 2,
                        "The political view must be specified as two letters ISO 3166-1 standard!"
                    );
                    const povFeatureModifier = new OmvPoliticalViewFeatureModifier(politicalView);
                    if (featureModifiers) {
                        featureModifiers.push(povFeatureModifier);
                    } else {
                        featureModifiers = [povFeatureModifier];
                    }
                }
                // Reset modifiers if nothing was added.
                this.m_featureModifiers =
                    featureModifiers && featureModifiers.length > 0 ? featureModifiers : undefined;
            }

            if (omvOptions.gatherFeatureAttributes !== undefined) {
                this.m_gatherFeatureAttributes = omvOptions.gatherFeatureAttributes === true;
            }
            if (omvOptions.skipShortLabels !== undefined) {
                this.m_skipShortLabels = omvOptions.skipShortLabels;
            }
            if (omvOptions.enableElevationOverlay !== undefined) {
                this.m_enableElevationOverlay = omvOptions.enableElevationOverlay;
            }
            if (omvOptions.roundUpCoordinatesIfNeeded !== undefined) {
                this.m_roundUpCoordinatesIfNeeded = omvOptions.roundUpCoordinatesIfNeeded;
            }
        }
        if (options?.languages !== undefined) {
            this.languages = options.languages;
        }
    }

    private createFeatureModifier(
        filterDescription: OmvFeatureFilterDescription,
        featureModifierId?: FeatureModifierId
    ): OmvFeatureModifier {
        switch (featureModifierId) {
            case FeatureModifierId.default:
                return new OmvGenericFeatureModifier(filterDescription);
            default:
                assert(!"Unrecognized feature modifier id, using default!");
                return new OmvGenericFeatureModifier(filterDescription);
        }
    }
}

/**
 * Vector Tile Decoder Service.
 */
export class VectorTileDecoderService {
    /**
     * Register a vector tile decoder service.
     *
     * @remarks
     * Has to be called during initialization of decoder bundle.
     */
    static start() {
        WorkerServiceManager.getInstance().register({
            serviceType: VECTOR_TILE_DECODER_SERVICE_TYPE,
            factory: (serviceId: string) =>
                TileDecoderService.start(serviceId, new VectorTileDecoder())
        });
    }
}
