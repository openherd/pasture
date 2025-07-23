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
window.showMap = function (latitude, longitude) {
  const popup = new Popup({
    id: "map",
    title: "",
    content:
      "",
    sideMargin: "2.9vw",
    titleColor: "#fff",
    textColor: "#fff",
    backgroundColor: "#222",
    closeColor: "#fff",
    fontSizeMultiplier: 1.2,
    linkColor: "#888",
    hideCallback: () => {
      window.map.remove();
      document.querySelector(".popup").remove()
    },
  });
  popup.show()
  const mapContainer = document.createElement('div');
  mapContainer.id = 'map';
  mapContainer.style.width = '100%';
  mapContainer.style.height = '400px';
  document.querySelector(".popup-body").appendChild(mapContainer);

  window.map = L.map('map').setView([latitude, longitude], 13);

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
  }).addTo(map);

  L.marker([latitude, longitude]).addTo(map)
    .bindPopup('Approx. Location')
    .openPopup();
}
window.getUserLocation = function (position, auto) {
  const { latitude, longitude } = window.skewLocation(position.coords.latitude, position.coords.longitude)
  sessionStorage.setItem("lat", latitude)
  sessionStorage.setItem("lon", longitude)
  document.cookie = "lat=" + latitude + "; path=/";
  document.cookie = "lon=" + longitude + "; path=/";
  if (auto) window.location.reload();
}
if (location.pathname != "/new" && (!document.cookie.includes("lat") || !document.cookie.includes("lon"))) {
  navigator.geolocation.getCurrentPosition(function (a) { getUserLocation(a, true) });

}

window.setActiveNavItem = function() {
  const navLinks = document.querySelectorAll('.sidebar-nav .nav-link');
  navLinks.forEach(link => {
    link.classList.remove('active');
    link.removeAttribute('aria-current');
  });

  const currentPath = window.location.pathname;
  
  navLinks.forEach(link => {
    const linkPath = new URL(link.href).pathname;
    if (linkPath === currentPath) {
      link.classList.add('active');
      link.setAttribute('aria-current', 'page');
    }
  });
};

document.addEventListener('DOMContentLoaded', function() {
  setActiveNavItem();
});