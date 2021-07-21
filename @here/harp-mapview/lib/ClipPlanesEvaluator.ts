/*
 * Copyright (C) 2019-2021 HERE Europe B.V.
 * Licensed under Apache 2.0, see full license in LICENSE
 * SPDX-License-Identifier: Apache-2.0
 */

import { ViewRanges } from "@here/harp-datasource-protocol/lib/ViewRanges";
import { EarthConstants, Projection, ProjectionType } from "@here/harp-geoutils";
import { assert } from "@here/harp-utils";
import * as THREE from "three";

import { ElevationProvider } from "./ElevationProvider";
import { MapViewUtils } from "./Utils";

const epsilon = 0.000001;

namespace SphericalProj {
    const tmpVectors: THREE.Vector3[] = [new THREE.Vector3(), new THREE.Vector3()];

    /**
     * Calculate the horizon distance from a point above a sphere's surface.
     *
     * @remarks
     * Returns zero if point is below surface or only very slightly above surface of sphere.
     * @see https://en.wikipedia.org/wiki/Horizon#Derivation
     * @param d - Distance from point to center of sphere.
     * @param r - Radius of sphere.
     */
    function getHorizonDistance(d: number, r: number): number {
        // There may be situations when maximum elevation still remains below sea level
        // (elevation < 0) or it is negligible (elevation ~ epsilon)
        return d - r < epsilon ? 0 : Math.sqrt(d * d - r * r);
    }

    /**
     * Calculate furthest visible distance from camera position projected on eye direction.
     *
     * @remarks
     * Furthest visible distance is assumed to be distance from camera to horizon
     * plus distance from elevated geometry to horizon(so that high objects behind horizon
     * remain visible).
     * @see https://en.wikipedia.org/wiki/Horizon#Objects_above_the_horizon
     * @param d - Distance from camera to origin.
     * @param minR - Min sphere radius.
     * @param maxR - Max sphere radius.
     * @param alpha - Angle between camera eye vector and tangent.
     */
    export function getFarDistanceFromElevatedHorizon(
        camera: THREE.PerspectiveCamera,
        d: number,
        minR: number,
        maxR: number
    ): number {
        //         , - ~ ~ ~ - ,
        //     , '               ' ,        E
        //   ,           .           ,    . ' far + elev
        //  ,            .   maxR    , '   /
        // ,             .     ,  '    ,  /
        // ,             . O '         , / te
        // ,             | .           ,/
        //  ,            |   . minR   ,/
        //   ,           |      .    ,
        //     ,         |        , '_____ far
        //       ' -_, _ | _ ,  ' / T (Tangent point = Horizon)
        //     near      |  eye   /
        //             d |  +   / t
        //               | +  /
        //               |+ /
        //               C ---> up

        // Compute angle between camera eye vector and tangent in camera's up direction.
        const normalToTanAngle = Math.asin(minR / d);
        const eyeToTanAngle = Math.abs(normalToTanAngle - SphericalProj.getCameraPitch(camera));

        const t = getHorizonDistance(d, minR);

        // Because we would like to see elevated geometry that may be visible beyond
        // the tangent point on ground surface, we need to extend viewing distance along
        // the tangent line by te (see graph above).
        const te = getHorizonDistance(maxR, minR);

        // Project CE vector(length t + te) onto eye vector to get far distance.
        const far = Math.cos(eyeToTanAngle) * (t + te);

        return far;
    }

    /**
     * Computes the far plane given the point where the upper right frustum edge intersects with
     * the earth's sphere projected along the camera's view direction.
     * @param worldSpaceIntersection - Furthest intersection point between frustum an sphere.
     * @param camera - The camera.
     * @returns Camera pitch.
     */
    export function getFarPlaneBasedOnFovIntersection(
        worldSpaceIntersection: THREE.Vector3,
        camera: THREE.PerspectiveCamera
    ): number {
        const toIntersection = tmpVectors[0].copy(worldSpaceIntersection).sub(camera.position);
        return toIntersection.dot(camera.getWorldDirection(tmpVectors[1]));
    }

    /**
     * Calculate angle between look at and surface normal at camera position.
     * @param camera - The camera.
     * @returns Camera pitch.
     */
    export function getCameraPitch(camera: THREE.PerspectiveCamera): number {
        const camToOriginDir = tmpVectors[0].copy(camera.position).negate().normalize();
        const cosPitch = camToOriginDir.dot(camera.getWorldDirection(tmpVectors[1]));
        return Math.acos(THREE.MathUtils.clamp(cosPitch, -1.0, 1.0));
    }
}

export interface ClipPlanesEvaluator {
    /**
     * Minimum elevation to be rendered, values beneath the sea level are negative.
     */
    minElevation: number;

    /**
     * Set maximum elevation to be rendered, values above sea level are positive.
     */
    maxElevation: number;

    /**
     * Compute near and far clipping planes distance.
     *
     * @remarks
     * Evaluation method should be called on every frame  and camera clip planes updated.
     * This is related to evaluator implementation and its input data, that may suddenly change
     * such as camera position or angle, projection type or so.
     * Some evaluators may not depend on all or even any of input objects, but to preserve
     * compatibility with any evaluator type it is strongly recommended to update on every frame.
     * @note The camera clipping planes (near/far properties) aren't automatically updated
     * via #evaluateClipPlanes() call, user should do it manually if needed.
     * @param camera - The [[THREE.Camera]] in use.
     * @param projection - The geo-projection currently used for encoding geographic data.
     * @param elevationProvider - The optional elevation provider for fine tuned range calculation,
     * taking into account terrain variability and unevenness.
     *
     */
    evaluateClipPlanes(
        camera: THREE.Camera,
        projection: Projection,
        elevationProvider?: ElevationProvider
    ): ViewRanges;
}

/**
 * Abstract evaluator class that adds support for elevation constraints.
 *
 * @remarks
 * Classes derived from this should implement algorithms that takes into account rendered
 * features height (elevations), such as ground plane is no more flat (or spherical), but
 * contains geometry that should be overlapped by frustum planes.
 */
export abstract class ElevationBasedClipPlanesEvaluator implements ClipPlanesEvaluator {
    private m_maxElevation: number;
    private m_minElevation: number;

    constructor(maxElevation: number, minElevation: number) {
        assert(maxElevation >= minElevation);
        this.m_minElevation = minElevation;
        this.m_maxElevation = maxElevation;
    }

    abstract evaluateClipPlanes(
        camera: THREE.Camera,
        projection: Projection,
        elevationProvider?: ElevationProvider
    ): ViewRanges;

    /**
     * Set maximum elevation above sea level to be rendered.
     *
     * @remarks
     * @param elevation - the elevation (altitude) value in world units (meters).
     * @note If you set this exactly to the maximum rendered feature height (altitude above
     * the sea, you may notice some flickering or even polygons disappearing related to rounding
     * errors or depth buffer precision. In such cases increase [[nearFarMargin]] or add a little
     * bit offset to your assumed maximum elevation.
     * @note Reasonable values are in between (-DeadSeeDepression, MtEverestHeight>, both values
     * are defined in [[EarthConstant]] as [[EarthConstant.MIN_ELEVATION]] and
     * [[EarthConstant.MAX_ELEVATION]] respectively.
     * @see minElevation for more information about precision and rounding errors.
     */
    set maxElevation(elevation: number) {
        this.m_maxElevation = elevation;
        // Min elevation should be at least equal or smaller to max elevation.
        this.m_minElevation = Math.min(elevation, this.m_minElevation);
    }

    /**
     * Get maximum elevation to be covered by camera frustum.
     */
    get maxElevation(): number {
        return this.m_maxElevation;
    }

    /**
     * Set minimum elevation to be rendered, values beneath the sea level are negative.
     *
     * @remarks
     * @param elevation - the minimum elevation (depression) in world units (meters).
     * @note If you set this parameter to zero you may not see any features rendered if they are
     * just below the sea level more than half of [[nearFarMargin]] assumed. Similarly if set to
     * -100m and rendered features lays exactly in such depression, you may notice that problem.
     * The errors usually come from projection precision loss and depth buffer nature (significant
     * precision loss closer to far plane). Thus is such cases either increase the margin (if you
     * are sure features are just at this elevation, or setup bigger offset for [[minElevation]].
     * Reasonable values are between <-DeadSeaDepression, MtEverestHeight), where the first denotes
     * lowest depression on the Earth defined as [[EarthConstants.MIN_ELEVATION]] and the second is
     * the highest point our planet.
     * @see https://developer.nvidia.com/content/depth-precision-visualized
     */
    set minElevation(elevation: number) {
        this.m_minElevation = elevation;
        // Max elevation should be at least equal or bigger than min elevation.
        this.m_maxElevation = Math.max(elevation, this.m_maxElevation);
    }

    /**
     * Get minimum elevation to be covered by camera frustum.
     */
    get minElevation(): number {
        return this.m_minElevation;
    }
}

/**
 * Top view, clip planes evaluator that computes view ranges based on ground distance and elevation.
 *
 * @deprecated Default evaluator {@link TiltViewClipPlanesEvaluator} supports top-down views.
 *
 * @remarks
 * This evaluator supports both planar and spherical projections, although it behavior is
 * slightly different in each case. General algorithm sets near plane and far plane close
 * to ground level, but taking into account maximum and minimum elevation of features on the ground.
 *
 * @note This evaluator supports only cameras which are always looking down the ground surface
 * (top-down view) along surface normal and does not preserve correct clip planes when
 * modifying camera pitch (tilt) angle. In simple words it is suitable only for top view camera
 * settings.
 */
export class TopViewClipPlanesEvaluator extends ElevationBasedClipPlanesEvaluator {
    /**
     * Helper for reducing number of objects created at runtime.
     */
    protected m_tmpVectors: THREE.Vector3[] = [
        new THREE.Vector3(),
        new THREE.Vector3(),
        new THREE.Vector3()
    ];

    /**
     * Helper object for reducing performance impact.
     */
    protected m_tmpQuaternion: THREE.Quaternion = new THREE.Quaternion();

    protected m_sphere: THREE.Sphere;

    private readonly m_minimumViewRange: ViewRanges;

    /**
     * Allows to setup near/far offsets (margins), rendered geometry elevation relative to sea
     * level as also minimum near plane and maximum far plane distance constraints.
     *
     * @remarks
     * It is strongly recommended to set some reasonable [[nearFarMargin]] (offset) between near
     * and far planes to avoid flickering.
     * @param maxElevation - defines near plane offset from the ground in the surface normal
     * direction, positive values allows to render elevated terrain features (mountains,
     * buildings). Defaults to Burj Khalifa building height.
     * @param minElevation - defines far plane offset from the ground surface, negative values moves
     * far plane below the ground level (use it to render depressions). Default zero - sea level.
     * @param nearMin - minimum allowable near plane distance from camera, must be bigger than zero.
     * @param nearFarMarginRatio - minimum distance between near and far plane, as a ratio of
     * average near/far plane distance, it have to be significantly bigger than zero (especially if
     * [[maxElevation]] and [[minElevation]] are equal), otherwise you may notice flickering when
     * rendering, or even render empty scene if frustum planes are almost equal.
     * @param farMaxRatio - maximum ratio between ground and far plane distance, allows to limit
     * viewing distance at overall. Have to be bigger than 1.0.
     * @note Keep in mind that this evaluator does not evaluate terrain (or building) elevation
     * automatically, to keep such features rendered (between frustum planes) use [[minElevation]],
     * [[maxElevation]] constraints. You may change this parameters at any time, but it requires
     * repeating [[evaluatePlanes]] step, if your camera is moving you need to evaluate planes
     * anyway.
     * @note You may treat [[minElevation]] and [[maxElevation]] parameters as the maximum and
     * minimum renderable elevation respectively along the surface normal, when camera is
     * constantly looking downwards (top-down view). If you need {@link ClipPlanesEvaluator} for
     * cameras that support tilt or yaw please use {@link TiltViewClipPlanesEvaluator}.
     * @note [[nearFarMaxRatio]] does not limit far plane when spherical projection is in use,
     * the algorithm used there estimates distance to point on tangent where line from camera
     * touches the sphere horizon and there is no reason to clamp it.
     */
    constructor(
        maxElevation: number = EarthConstants.MAX_BUILDING_HEIGHT,
        minElevation: number = 0,
        readonly nearMin: number = 1.0,
        readonly nearFarMarginRatio: number = 0.05,
        readonly farMaxRatio = 6.0
    ) {
        super(maxElevation, minElevation);
        assert(nearMin > 0);
        assert(nearFarMarginRatio > epsilon);
        assert(farMaxRatio > 1.0);
        const nearFarMargin = nearFarMarginRatio * nearMin;
        this.m_minimumViewRange = {
            near: nearMin,
            far: nearMin + nearFarMargin,
            minimum: this.nearMin,
            maximum: Math.max(nearMin * farMaxRatio, nearMin + nearFarMargin)
        };
        this.m_sphere = new THREE.Sphere(new THREE.Vector3(), EarthConstants.EQUATORIAL_RADIUS);
    }

    /** @override */
    evaluateClipPlanes(
        camera: THREE.Camera,
        projection: Projection,
        elevationProvider?: ElevationProvider
    ): ViewRanges {
        if (projection.type === ProjectionType.Spherical) {
            return this.evaluateDistanceSphericalProj(camera, projection, elevationProvider);
        } else if (projection.type === ProjectionType.Planar) {
            return this.evaluateDistancePlanarProj(camera, projection, elevationProvider);
        }
        assert(false, "Unsupported projection type");
        return { ...this.minimumViewRange };
    }

    /**
     * Get minimum view range that is possible to achieve with current evaluator settings.
     * @note This value will not change after evaluator is constructed.
     */
    protected get minimumViewRange(): ViewRanges {
        return this.m_minimumViewRange;
    }

    protected evaluateDistancePlanarProj(
        camera: THREE.Camera,
        projection: Projection,
        elevationProvider?: ElevationProvider
    ): ViewRanges {
        assert(projection.type !== ProjectionType.Spherical);

        let nearPlane: number = this.nearMin;
        let farPlane: number = this.nearMin * this.farMaxRatio;

        // Calculate distance to closest point on the ground.
        const groundDistance = projection.groundDistance(camera.position);
        const farMax = groundDistance * this.farMaxRatio;
        // We could at least try to keep margins along the eye vector (center of the view) in
        // tact with pitch angle changes, but this does not solve all tilt angle problems,
        // rather use more sophisticated evaluator.
        nearPlane = groundDistance - this.maxElevation;
        farPlane = groundDistance - this.minElevation;

        // Apply the constraints.
        nearPlane = Math.max(nearPlane, this.nearMin);
        farPlane = Math.min(farPlane, farMax);
        // Apply margins
        const nearFarMargin = (this.nearFarMarginRatio * (nearPlane + farPlane)) / 2;
        nearPlane = Math.max(nearPlane - nearFarMargin / 2, this.nearMin);
        farPlane = Math.max(farPlane + nearFarMargin / 2, nearPlane + nearFarMargin);

        const viewRanges: ViewRanges = {
            near: nearPlane,
            far: farPlane,
            minimum: this.nearMin,
            maximum: Math.max(farMax, farPlane)
        };
        return viewRanges;
    }

    protected evaluateDistanceSphericalProj(
        camera: THREE.Camera,
        projection: Projection,
        elevationProvider?: ElevationProvider
    ): ViewRanges {
        assert(projection.type === ProjectionType.Spherical);

        let nearPlane: number = this.nearMin;
        let farPlane: number = this.nearMin * this.farMaxRatio;

        // The near plane calculus is quite straight forward and works the same as for planar
        // projections. We simply search for the closest point of the ground just above
        // the camera, then we apply margin (elevation) to it along the sphere surface normal:
        const cameraAltitude = projection.groundDistance(camera.position);
        nearPlane = cameraAltitude - this.maxElevation;

        // Far plane calculation requires different approaches depending from camera projection:
        // - perspective
        // - orthographic

        const r = EarthConstants.EQUATORIAL_RADIUS;
        let d = camera.position.length();
        d = d === 0 ? epsilon : d;
        if (camera.type === "PerspectiveCamera") {
            // This solution computes near and far plane for a set up where
            // the camera is looking at the center of the scene.

            // The far plane distance calculus requires finding the sphere tangent line that is
            // co-linear with (goes thru) camera position, such tangent creates right angle
            // with sphere diameter where it touches its surface (point T). Given that sphere is
            // always at world origin and camera orbits around it we have (see
            // #getTangentBasedFarPlane):
            // angle(OTC) = 90
            // sin(OCT) = sin(alpha) = r / d
            // alpha = asin(r / d)
            const alpha = Math.asin(r / d);
            // If alpha it bigger than half fov angle, our visibility limit is set by tangent
            // line, otherwise we need to find top (or right) plane intersection with sphere,
            // which is definitely closer than the tangent point mentioned above.
            const cam = camera as THREE.PerspectiveCamera;
            // Take fov directly if it is vertical, otherwise we translate it using aspect ratio:

            let halfFovAngle = THREE.MathUtils.degToRad(cam.fov / 2);
            // If width > height, then we have to compute the horizontal FOV.
            if (cam.aspect > 1) {
                halfFovAngle = MapViewUtils.calculateHorizontalFovByVerticalFov(
                    THREE.MathUtils.degToRad(cam.fov),
                    cam.aspect
                );
            }

            const maxR = r + this.maxElevation;
            const farTangent = SphericalProj.getFarDistanceFromElevatedHorizon(cam, d, r, maxR);
            farPlane =
                halfFovAngle > alpha
                    ? farTangent
                    : this.getFovBasedFarPlane(cam, d, r, 2 * halfFovAngle, projection);
        }
        // Orthographic camera projection
        else {
            farPlane = this.getOrthoBasedFarPlane(d, r);
        }

        // In extreme cases the largest depression assumed may be further than tangent
        // based far plane distance, take it into account
        const farMin = cameraAltitude - this.minElevation;
        const farMax = cameraAltitude * this.farMaxRatio;
        // Apply the constraints.
        nearPlane = Math.max(nearPlane, this.nearMin);
        farPlane = Math.max(farPlane, farMin);
        // Apply margins
        const nearFarMargin = (this.nearFarMarginRatio * (nearPlane + farPlane)) / 2;
        nearPlane = Math.max(nearPlane - nearFarMargin / 2, this.nearMin);
        farPlane = Math.max(farPlane + nearFarMargin / 2, nearPlane + nearFarMargin);

        const viewRanges: ViewRanges = {
            near: nearPlane,
            far: farPlane,
            minimum: this.nearMin,
            maximum: farMax
        };
        return viewRanges;
    }

    protected getFovBasedFarPlane(
        camera: THREE.PerspectiveCamera,
        d: number,
        r: number,
        fovAngle: number,
        projection: Projection
    ) {
        // Find intersection point that is closer to tangent point.
        //
        //         , - ~ ~ ~ - ,
        //     , '               ' ,
        //   ,           .           ,
        //  ,            .     r     ,' T1
        // ,             .     ,  '  / ,
        // ,             . O.'  a   /  ,
        // ,             | .  `  . /   ,
        //  ,            |   .  r / TA,
        //   ,           |    .  /   ,
        //     ,         |     ./  ,'_____ far
        //       ' -_, _ | _ , /' T0
        //     near      |    /
        //               |   / t
        //             d | /
        //               |/
        //               C
        //
        // See:
        // https://www.scratchapixel.com/lessons/3d-basic-rendering/minimal-ray-tracer-rendering-simple-shapes/ray-sphere-intersection

        // Vector from camera to world center
        const dVec = camera.position;
        // Extract camera X, Y, Z orientation axes into tmp vectors array.
        camera.matrixWorld.extractBasis(
            this.m_tmpVectors[0],
            this.m_tmpVectors[1],
            this.m_tmpVectors[2]
        );
        // Setup quaternion (X axis based) for angle between frustum plane and camera eye.
        this.m_tmpQuaternion.setFromAxisAngle(this.m_tmpVectors[0], fovAngle / 2);
        // Acquire camera (eye) forward vector from Z axis (keep it in tmpVectors[2]).
        const cameraFwdVec = this.m_tmpVectors[2];
        // Apply quaternion to forward vector, creating intersection vector, which is
        // parallel to top or right frustum plane (depending on the aspect ratio).
        const tVec = this.m_tmpVectors[1].copy(cameraFwdVec).applyQuaternion(this.m_tmpQuaternion);
        // Calculate camera to origin vector projection onto frustum plane (top or right).
        // This gives us the length of CTA segment:
        const cta = dVec.dot(tVec);
        // If it is negative, it means that the dVec and the tVec points in
        // opposite directions - there is no intersection - or intersection could
        // potentially be behind the intersection ray's origin (camera position).
        if (cta < 0) {
            // Intersection points are behind camera, camera looks in wrong direction.
            const groundDistance = projection.groundDistance(camera.position);
            // Setup far plane to maximum distance.
            return groundDistance * this.farMaxRatio;
        }
        // Knowing the length of |CTA| we just need to subtract the length of |T0TA|
        // segment from it to get far plane distance.
        // In order to calculate |T0TA| we firstly need to use use Pythagorean theorem to
        // find length of |OTA| = a. Here we use the right triangle formed by O-C-TA points:
        // |OC|^2 = |CTA|^2 + |OTA|^2, where |OTA| = a, |OC| = d, |CTA| = cta
        // a^2 = d^2 - cta^2
        const a2 = dVec.dot(dVec) - cta * cta;
        // Note that if a is greater than sphere radius the ray misses the sphere and
        // thus there is no intersection at all.
        const r2 = r * r;
        assert(a2 <= r2, "Please use this evaluator only for top view camera poses.");
        // Now to find the length of |T0TA| == |T1TA| we use the second right triangle
        // formed by O-T0-TA points. Of course we know that |T0TA| segment length is
        // equal to |T1TA|, and |OT0| segment is simply sphere radius.
        // In order to find |T0TA| length we again use Pythagorean theorem, which says:
        // |OT0|^2 = |OTA|^2 + |T0TA|^2, where |OTO| = r, |OTA| = a
        // |T0TA|^2 = r^2 - a^2
        const tota = Math.sqrt(r2 - a2);
        // Finally our far plane (intersection point) is defined as:
        return cta - tota;
    }

    protected getOrthoBasedFarPlane(d: number, r: number): number {
        //         , - ~ ~ ~ - ,
        //     , '               ' ,     E
        //   ,            .--------- ,-.'- far + elev
        // | ,            .   r + e , `, |
        // |,             .     , '     ,| te
        // |,             . O '.........,|..
        // |,             |        r    ,|  far
        // | ,            |            , |
        // |  ,           |           ,  | t
        // |    ,         |        , '   |
        // |      ' -_, _ | _ ,  '       |
        // |    near      | \/___________| near - elev
        // |              |              |
        // |            d |              |
        // |              |              |
        //                C
        // The distance to tangent point may be described as:
        const t = d;
        // Tangent extension due to terrain elevation behind the horizon may be calculated
        // based on the right triangle:
        // (r+maxElev)^2 = r^2 + te^2
        // te = sqrt((r+maxElev)^2 - r^2)
        // although we may not calculate it if elevation is negligible:
        const te =
            this.maxElevation < epsilon
                ? 0
                : Math.sqrt(r + this.maxElevation) * (r + this.maxElevation) - r * r;
        // Both near and far planes distances are directly applied to frustum, because tangents'
        // lines are parallel to camera look at vector.
        // Now far plane distance is constituted with:
        return t + te;
    }
}

/**
 * Evaluates camera clipping planes taking into account ground distance and camera angles.
 *
 * @remarks
 * This evaluator provides support for camera with varying tilt (pitch) angle, the angle
 * between camera __look at__ vector and the ground surface normal.
 */
export class TiltViewClipPlanesEvaluator extends TopViewClipPlanesEvaluator {
    private readonly m_ray = new THREE.Ray();
    /**
     * Calculate the lengths of frustum planes intersection with the ground plane.
     *
     * @remarks
     * This evaluates distances between eye vector (or eye plane in orthographic projection) and
     * ground intersections of top and bottom frustum planes.
     * @note This method assumes the world surface (ground) to be flat and
     * works only with planar projections.
     *
     * @param camera - The [[THREE.Camera]] instance in use,
     * @param projection - The geo-projection used to convert geographic to world coordinates.
     */
    private getFrustumGroundIntersectionDist(
        camera: THREE.Camera,
        projection: Projection
    ): { top: number; bottom: number } {
        assert(projection.type !== ProjectionType.Spherical);
        // This algorithm computes the length of frustum planes before intersecting with a flat
        // ground surface. Entire computation is split over two projections method and performed
        // for top and bottom plane, with addition of terrain (ground) elevation which is taken
        // into account.
        // The following diagram may help explain the algorithm below.
        //   🎥
        //   C
        //   |\
        //   |.\ .
        //   | . \  . t
        // z |  .  \   .c2
        //   |  c1.  \e ___. max elev
        //   |     .   \      .
        //___|a___D1.____\E1_____.D2______ g
        //   C1      .     \ __. min elev
        //            .      \.E2
        //          b  .    .
        //              . .
        //               .
        // Where:
        // - C gives the camera position.
        // - z is the height of the camera above the ground.
        // - z1 == z2 == z, for perspective camera all planes origin its the same
        // - a is a right angle.
        // - e is the look at vector of the camera.
        // - t and b are the frustum planes of the camera (top and bottom respectively).
        // - angle between c1 to c2 is the fov.
        // - c1, c2 - vectors from camera to the ground along frustum planes.
        // - angles between c1 and e or e and c2 splits fov on equal halves.
        // - d1 and d2 are the intersection points of the frustum with the world/ground plane.
        // - angle between z and e is the pitch of the camera.
        // - angle between g and e is the tilt angle.
        // - g is the ground/world surface
        //
        // The goal is to find distance for top/bottom planes intersections of frustum with ground
        // plane.
        // This are the distances from C->D1 and C->D2, and are described as
        // c1 and c2. Then we may compensate/correct those distances with actual
        // ground elevations, which is done by simply offsetting camera altitude, as it is
        // opposite to elevating ground level.
        const halfPiLimit = Math.PI / 2 - epsilon;
        const cameraAltitude = projection.groundDistance(camera.position);
        const cameraTilt = MapViewUtils.extractCameraTilt(camera, projection);
        // Angle between z and c2
        let topAngleRad: number;
        // Angle between z and c1
        let bottomAngleRad: number;
        // Bottom plane origin altitude
        let z1: number;
        // Top plane origin altitude
        let z2: number;
        // For perspective projection:
        if (camera instanceof THREE.PerspectiveCamera) {
            // Angle between z and c2, note, the fov is vertical, otherwise we would need to
            // translate it using aspect ratio:
            // Half fov angle in radians
            const halfFovAngle = THREE.MathUtils.degToRad(camera.fov / 2);
            topAngleRad = THREE.MathUtils.clamp(
                cameraTilt + halfFovAngle,
                -halfPiLimit,
                halfPiLimit
            );
            bottomAngleRad = THREE.MathUtils.clamp(
                cameraTilt - halfFovAngle,
                -halfPiLimit,
                halfPiLimit
            );
            z1 = z2 = cameraAltitude;
        }
        // For orthographic projection:
        else {
            assert(camera instanceof THREE.OrthographicCamera, "Unsupported camera type.");
            const cam = (camera as any) as THREE.OrthographicCamera;
            // For orthogonal camera projections we may simply ignore FOV and use 0 for FOV
            // the top/bottom planes are simply parallel to the eye vector:
            topAngleRad = bottomAngleRad = cameraTilt;
            // Although the ray origin is not always the same (eye position) as for
            // the perspective projections, thus we need to compensate for ortho-cube
            // dimensions:
            // sin(tilt) = zc2 / top
            // sin(tilt) = zc1 / bottom
            // zc2 = sin(tilt) * top
            // zc1 = sin(tilt) * bottom
            const sinBeta = Math.sin(cameraTilt);
            z2 = cameraAltitude + sinBeta * cam.top;
            z1 = cameraAltitude - sinBeta * cam.bottom;
        }
        // Distance along the top plane to the ground - c2
        // cos(topAngle) = (z2 - minElev) / |c2|
        // |c2| = (z2 - minElev) / cos(topAngle)
        const topDist = (z2 - this.minElevation) / Math.cos(topAngleRad);
        // Distance along the bottom plane to the ground - c1
        // cos(bottomAngle) = (z - minElev) / |c1|
        // |c1| = (z - minElev) / cos(bottomAngle)
        const bottomDist = (z1 - this.maxElevation) / Math.cos(bottomAngleRad);

        return {
            top: Math.max(topDist, 0),
            bottom: Math.max(bottomDist, 0)
        };
    }

    /** @override */
    protected evaluateDistancePlanarProj(
        camera: THREE.Camera,
        projection: Projection,
        elevationProvider?: ElevationProvider
    ): ViewRanges {
        assert(projection.type !== ProjectionType.Spherical);
        const viewRanges = { ...this.minimumViewRange };

        // Generally near/far planes are set to keep top/bottom planes intersection distance.
        // Then elevations margins are applied. Here margins (min/max elevations) are meant to
        // be defined as distance along the ground normal vector thus during camera
        // tilt they may affect near/far planes positions differently.
        const planesDist = this.getFrustumGroundIntersectionDist(camera, projection);

        // Project clipping plane distances for the top/bottom frustum planes (edges), but
        // only if we deal with perspective camera type, this step is not required
        // for orthographic projections, cause all clip planes are parallel to eye vector.
        if (camera instanceof THREE.PerspectiveCamera) {
            // Angle between z and c2, note, the fov is vertical, otherwise we would need to
            // translate it using aspect ratio:
            // Half fov angle in radians
            const halfFovAngle = THREE.MathUtils.degToRad(camera.fov / 2);
            const cosHalfFov = Math.cos(halfFovAngle);
            // cos(halfFov) = near / bottomDist
            // near = cos(halfFov) * bottomDist
            viewRanges.near = planesDist.bottom * cosHalfFov;
            // cos(halfFov) = far / topDist
            // far = cos(halfFov) * topDist
            viewRanges.far = planesDist.top * cosHalfFov;
        }
        // Orthographic camera projection.
        else {
            assert(camera instanceof THREE.OrthographicCamera, "Unsupported camera type.");
            viewRanges.near = planesDist.bottom;
            viewRanges.far = planesDist.top;
        }

        return this.applyViewRangeConstraints(viewRanges, camera, projection, elevationProvider);
    }

    /** @override */
    protected evaluateDistanceSphericalProj(
        camera: THREE.Camera,
        projection: Projection,
        elevationProvider?: ElevationProvider
    ): ViewRanges {
        assert(projection.type === ProjectionType.Spherical);
        const viewRanges = { ...this.minimumViewRange };

        // Near plane calculus is pretty straightforward and does not depend on camera tilt:
        viewRanges.near = projection.groundDistance(camera.position) - this.maxElevation;

        // Far plane calculation requires different approaches depending from camera projection:
        // - perspective
        // - orthographic
        const r = EarthConstants.EQUATORIAL_RADIUS;
        const maxR = r + this.maxElevation;
        const d = camera.position.length();

        if (camera instanceof THREE.PerspectiveCamera) {
            const halfVerticalFovAngle = THREE.MathUtils.degToRad(camera.fov / 2);

            // Now we need to account for camera tilt and frustum volume, so the longest
            // frustum edge does not intersects with sphere, it takes the worst case
            // scenario regardless of camera tilt, so may be improved little bit with more
            // sophisticated algorithm.
            viewRanges.near *= Math.cos(halfVerticalFovAngle);

            // Ratio of the depth of the camera compared to the distance between the center of the
            // screen and the middle of the top of the screen (here set to be value 1). We just need
            // this to be a ratio because we are interested in just computing the direction of the
            // upper right corner and not any specific length.
            const zLength = 1 / Math.tan(halfVerticalFovAngle);

            // Camera space direction vector along the top right frustum edge (of the camera).
            const upperRightDirection = this.m_tmpVectors[0]
                .set(camera.aspect, 1, -zLength)
                .applyMatrix4(camera.matrixWorld)
                .sub(camera.position);

            // Ray must be given normalized vector, otherwise it won't work
            this.m_ray.set(camera.position, upperRightDirection.normalize());

            // World space intersection with sphere or null
            const fovSphereIntersection = this.m_ray.intersectSphere(
                this.m_sphere,
                this.m_tmpVectors[0]
            );

            if (fovSphereIntersection === null) {
                // Use tangent based far plane if horizon is within field of view
                viewRanges.far = SphericalProj.getFarDistanceFromElevatedHorizon(
                    camera,
                    d,
                    r,
                    maxR
                );
            } else {
                viewRanges.far = SphericalProj.getFarPlaneBasedOnFovIntersection(
                    fovSphereIntersection,
                    camera
                );
            }
        } else {
            viewRanges.far = this.getOrthoBasedFarPlane(d, r);
        }

        return this.applyViewRangeConstraints(viewRanges, camera, projection, elevationProvider);
    }

    private applyViewRangeConstraints(
        viewRanges: ViewRanges,
        camera: THREE.Camera,
        projection: Projection,
        elevationProvider?: ElevationProvider
    ): ViewRanges {
        // Compute the focus point (target) distance for current camera and projection setup,
        // in a same way the MapView component does.
        const { distance } = MapViewUtils.getTargetAndDistance(
            projection,
            camera,
            elevationProvider
        );
        // Apply the constraints.
        const farMin = projection.groundDistance(camera.position) - this.minElevation;
        const farMax = distance * this.farMaxRatio;
        viewRanges.near = Math.max(viewRanges.near, this.nearMin);
        viewRanges.far = THREE.MathUtils.clamp(viewRanges.far, farMin, farMax);

        // Apply margins.
        const nearFarMargin = (this.nearFarMarginRatio * (viewRanges.near + viewRanges.far)) / 2;
        viewRanges.near = Math.max(viewRanges.near - nearFarMargin / 2, this.nearMin);
        viewRanges.far = Math.max(
            viewRanges.far + nearFarMargin / 2,
            viewRanges.near + nearFarMargin
        );

        // Set minimum and maximum view range.
        viewRanges.minimum = this.nearMin;
        viewRanges.maximum = farMax;

        return viewRanges;
    }
}

/**
 * Provides the most basic evaluation concept giving fixed values with some constraints.
 */
export class FixedClipPlanesEvaluator implements ClipPlanesEvaluator {
    readonly minFar: number;
    private m_nearPlane: number;
    private m_farPlane: number;

    constructor(readonly minNear: number = 1, readonly minFarOffset: number = 10) {
        this.minFar = minNear + minFarOffset;
        this.m_nearPlane = minNear;
        this.m_farPlane = this.minFar;
    }

    get nearPlane(): number {
        return this.m_nearPlane;
    }

    set nearPlane(fixedNear: number) {
        this.invalidatePlanes(fixedNear, this.m_farPlane);
    }

    get farPlane(): number {
        return this.m_farPlane;
    }

    set farPlane(fixedFar: number) {
        this.invalidatePlanes(this.m_nearPlane, fixedFar);
    }

    set minElevation(elevation: number) {}

    get minElevation(): number {
        // This evaluator does not support elevation so its always set to 0.
        return 0;
    }

    set maxElevation(elevation: number) {}

    get maxElevation(): number {
        // This evaluator does not support elevation so its always set to 0.
        return 0;
    }

    /** @override */
    evaluateClipPlanes(
        camera: THREE.Camera,
        projection: Projection,
        elevationProvider?: ElevationProvider
    ): ViewRanges {
        // We do not need to perform actual evaluation cause results are precomputed and
        // kept stable until somebody changes the properties.
        const viewRanges: ViewRanges = {
            near: this.m_nearPlane,
            far: this.m_farPlane,
            minimum: this.minNear,
            maximum: this.m_farPlane
        };
        return viewRanges;
    }

    private invalidatePlanes(near: number, far: number) {
        // When clamping prefer to extend far plane at about minimum distance, giving
        // near distance setup priority over far.
        const nearDist: number = Math.max(this.minNear, near);
        const farDist: number = Math.max(this.minFar, far, nearDist + this.minFarOffset);
        this.m_nearPlane = nearDist;
        this.m_farPlane = farDist;
    }
}

/**
 * Factory function that creates default {@link ClipPlanesEvaluator}
 * that calculates near plane based
 * on ground distance and camera orientation.
 *
 * Creates {@link TiltViewClipPlanesEvaluator}.
 * @internal
 */
export const createDefaultClipPlanesEvaluator = () => new TiltViewClipPlanesEvaluator();
