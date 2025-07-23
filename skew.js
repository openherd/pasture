const OVERPASS_ENDPOINT = 'https://overpass-api.de/api/interpreter';
import crypto from 'crypto';

function secureRandom() {
    const max = 0x1_0000_0000_0000; // 2^53
    return crypto.randomInt(0, max-1) / max;
}

function toRad(deg) {
    return deg * Math.PI / 180;
}
function toDeg(rad) {
    return rad * 180 / Math.PI;
}
function haversine(lat1, lon1, lat2, lon2) {
    const R = 6371;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2 +
        Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
        Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function contextSkew(lat, lon, context, settings = {}) {
    const {
        population = 1000,
        place = 'village',
        nearbyHouseCount = 10
    } = context;

    const {
        mode = 'privacy',            
        maintainCity = false,
        maintainPostalCode = false,
        maintainState = false,
        minDistanceKm = null,         
        maxDistanceKm = null,         
        biasDirection = null         
    } = settings;

    let minDist = 1, maxDist = 3;

    if (place === 'city') {
        minDist = 0.2; maxDist = 1.2;
    } else if (place === 'town') {
        minDist = 0.5; maxDist = 2;
    } else {
        minDist = 1; maxDist = 3;
    }

    if (population < 2000 || nearbyHouseCount < 5) {
        minDist = 2.5;
        maxDist = 5;
    }

    if (typeof minDistanceKm === 'number') minDist = minDistanceKm;
    if (typeof maxDistanceKm === 'number') maxDist = maxDistanceKm;

    const earthRadiusKm = 6371;
    const minDistRad = minDist / earthRadiusKm;
    const maxDistRad = maxDist / earthRadiusKm;

    let angle;
    if (biasDirection) {
        const baseAngle = toRad(biasDirection.degrees % 360);
        const deviation = Math.PI * (1 - biasDirection.weight);
        angle = baseAngle + (secureRandom() - 0.5) * deviation;
    } else {
        angle = secureRandom() * 2 * Math.PI;
    }

    let distanceRad;
    switch (mode) {
        case 'uniform':
            distanceRad = secureRandom() * (maxDistRad - minDistRad) + minDistRad;
            break;
        case 'plausible':
            distanceRad = minDistRad + (secureRandom() ** 2) * (maxDistRad - minDistRad); 
            break;
        case 'urbanSnap':
            distanceRad = 0.05 / earthRadiusKm; 
            break;
        case 'privacy':
        default:
            distanceRad = minDistRad + (1 - secureRandom() ** 1.5) * (maxDistRad - minDistRad); 
            break;
    }

    const dLat = toDeg(distanceRad * Math.cos(angle));
    const dLon = toDeg(distanceRad * Math.sin(angle)) / Math.cos(toRad(lat));

    const newLat = lat + dLat;
    const newLon = lon + dLon;

    return {
        latitude: newLat,
        longitude: newLon,
        contextUsed: { place, population, nearbyHouseCount },
        settingsApplied: {
            mode,
            maintainCity,
            maintainPostalCode,
            maintainState,
            minDistanceKm: minDist,
            maxDistanceKm: maxDist,
            biasDirection
        }
    };
}

export async function fuzzFromOverpass(lat, lon, settings = {}) {
    const radiusMeters = 1000;
    const query = `
    [out:json];
    (
      node["place"](around:${radiusMeters},${lat},${lon});
      node["building"](around:${radiusMeters},${lat},${lon});
    );
    out body;
  `;

    const res = await fetch(OVERPASS_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ data: query })
    });

    const json = await res.json();

    let population = 0;
    let place = 'village';
    let buildingCount = 0;

    for (const el of json.elements) {
        if (el.tags?.place) {
            place = el.tags.place;
            if (el.tags.population) {
                const parsedPop = parseInt(el.tags.population.replace(/\D/g, ''), 10);
                if (!isNaN(parsedPop)) population = parsedPop;
            }
        }
        if (el.tags?.building) buildingCount++;
    }

    const context = {
        population,
        place,
        nearbyHouseCount: buildingCount
    };

    return contextSkew(lat, lon, context, settings);
}
