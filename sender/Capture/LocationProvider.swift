//
//  LocationProvider.swift
//  SafeHaven — Capture
//
//  CoreLocation wrapper that emits enriched gps_update events. PROTOCOL §5.1:
//  base {lat,lng} plus accuracy (m), speed (m/s), heading (deg), altitude (m),
//  address (null today). Ports the legacy startGPS()/stopGPS() (App.js) which
//  used ~5s / ~5m updates, upgraded to native CoreLocation with background
//  updates enabled (UIBackgroundModes: location).
//
//  Permissions are requested IN-CONTEXT when location starts (i.e. on Tier ≥ 1
//  escalation), never at first launch.
//

import Foundation
import CoreLocation

/// Main-actor isolated: the owner (TierController) is @MainActor.
@MainActor
protocol LocationProviderDelegate: AnyObject {
    func locationProvider(_ provider: LocationProvider, didUpdate event: GPSUpdateEvent)
}

final class LocationProvider: NSObject {

    weak var delegate: LocationProviderDelegate?

    private let manager = CLLocationManager()
    private var isRunning = false
    /// Throttle to ~5s between emitted updates (legacy timeInterval: 5000).
    private var lastEmit: Date?
    private let minInterval: TimeInterval = 5.0

    override init() {
        super.init()
        manager.delegate = self
        manager.desiredAccuracy = kCLLocationAccuracyBest
        manager.distanceFilter = 5            // ~5m (legacy distanceInterval: 5)
        manager.pausesLocationUpdatesAutomatically = false
    }

    /// Begin location updates, requesting permission in-context (§ permission
    /// requests on escalation). Idempotent.
    func start() {
        guard !isRunning else { return }
        isRunning = true

        // Background updates require the "location" background mode + the
        // alwaysAndWhenInUse path; request when-in-use first (in-context).
        manager.requestWhenInUseAuthorization()

        // allowsBackgroundLocationUpdates may only be true once we have the
        // background mode AND an appropriate authorization; guard defensively.
        if manager.authorizationStatus == .authorizedAlways
            || manager.authorizationStatus == .authorizedWhenInUse {
            manager.allowsBackgroundLocationUpdates = true
        }

        manager.startUpdatingLocation()
        manager.startUpdatingHeading()
    }

    /// Stop location + heading updates. Idempotent.
    func stop() {
        guard isRunning else { return }
        isRunning = false
        manager.stopUpdatingLocation()
        manager.stopUpdatingHeading()
        manager.allowsBackgroundLocationUpdates = false
        lastEmit = nil
    }
}

extension LocationProvider: CLLocationManagerDelegate {

    func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        guard isRunning else { return }
        switch manager.authorizationStatus {
        case .authorizedAlways, .authorizedWhenInUse:
            manager.allowsBackgroundLocationUpdates = true
            manager.startUpdatingLocation()
            manager.startUpdatingHeading()
        default:
            break // denied/restricted — nothing to emit
        }
    }

    func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard isRunning, let loc = locations.last else { return }

        // Throttle to ~5s to match the legacy cadence and keep the event log light.
        let now = Date()
        if let last = lastEmit, now.timeIntervalSince(last) < minInterval { return }
        lastEmit = now

        let event = GPSUpdateEvent(
            lat: loc.coordinate.latitude,
            lng: loc.coordinate.longitude,
            accuracy: loc.horizontalAccuracy >= 0 ? loc.horizontalAccuracy : nil,
            speed: loc.speed >= 0 ? loc.speed : nil,                         // m/s
            heading: loc.course >= 0 ? loc.course : nil,                     // deg
            altitude: loc.verticalAccuracy >= 0 ? loc.altitude : nil,        // m
            address: nil                                                     // reverse-geocode deferred
        )
        // Hop to the main actor for the @MainActor delegate (TierController).
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            self.delegate?.locationProvider(self, didUpdate: event)
        }
    }

    func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        print("[location] error: \(error.localizedDescription)")
    }
}
