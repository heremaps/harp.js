import { ValueMap } from "@here/harp-datasource-protocol";
import { GeoPointLike } from "@here/harp-geoutils";

type OcmGeometry = OcmPointGeometry | OcmLineGeometry | OcmPolygonGeometry;

interface OcmPointGeometry {
    type: "Point";
    coordinates: GeoPointLike;
}

interface OcmLineGeometry {
    type: "Line";
    coordinates: GeoPointLike[];
}

interface OcmPolygonGeometry {
    type: "Polygon";
    coordinates: GeoPointLike[][];
}

export interface IOcmFeature {
    geometry: OcmGeometry;
    properties: ValueMap;
}

export interface IOcmData {
    [key: string]: IOcmFeature[];
}
