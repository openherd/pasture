window.skewLocation = function skewLocation(
  lat,
  lon,
  minDistanceKm = 2,
  maxDistanceKm = 2.7,
) {
  const earthRadiusKm = 6371;

  const minDistRad = minDistanceKm / earthRadiusKm;
  const maxDistRad = maxDistanceKm / earthRadiusKm;

  const randomDist = minDistRad + Math.random() * (maxDistRad - minDistRad);
  const randomAngle = Math.random() * 2 * Math.PI;

  const newLat = lat + randomDist * Math.cos(randomAngle) * (180 / Math.PI);

  const newLon =
    lon +
    (randomDist * Math.sin(randomAngle) * (180 / Math.PI)) /
      Math.cos((lat * Math.PI) / 180);

  return { latitude: newLat, longitude: newLon };
};
