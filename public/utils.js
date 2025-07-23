window.skewLocation = async function skewLocation(lat, lon) {
  function getCookie(name) {
    const v = document.cookie.match('(^|;) ?' + name + '=([^;]*)(;|$)');
    return v ? decodeURIComponent(v[2]) : null;
  }
  
  const mode = getCookie('randomnessMode') || 'clientRandom';
  
  if (mode === 'clientRandom') {
    const earthRadiusKm = 6371;
    const minDistanceKm = 2;
    const maxDistanceKm = 2.7;
    
    const minDistRad = minDistanceKm / earthRadiusKm;
    const maxDistRad = maxDistanceKm / earthRadiusKm;

    const randomDist = minDistRad + Math.random() * (maxDistRad - minDistRad);
    const randomAngle = Math.random() * 2 * Math.PI;

    const newLat = lat + randomDist * Math.cos(randomAngle) * (180 / Math.PI);
    const newLon = lon + (randomDist * Math.sin(randomAngle) * (180 / Math.PI)) / Math.cos((lat * Math.PI) / 180);

    return { latitude: newLat, longitude: newLon };
  }
  
  try {
    const response = await fetch('/api/skew-location', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        latitude: lat,
        longitude: lon
      })
    });
    
    if (!response.ok) {
      throw new Error('Failed to skew location');
    }
    
    const result = await response.json();
    return { latitude: result.latitude, longitude: result.longitude };
  } catch (error) {
    console.error('Error skewing location:', error);
    const earthRadiusKm = 6371;
    const minDistanceKm = 2;
    const maxDistanceKm = 2.7;
    
    const minDistRad = minDistanceKm / earthRadiusKm;
    const maxDistRad = maxDistanceKm / earthRadiusKm;

    const randomDist = minDistRad + Math.random() * (maxDistRad - minDistRad);
    const randomAngle = Math.random() * 2 * Math.PI;

    const newLat = lat + randomDist * Math.cos(randomAngle) * (180 / Math.PI);
    const newLon = lon + (randomDist * Math.sin(randomAngle) * (180 / Math.PI)) / Math.cos((lat * Math.PI) / 180);

    return { latitude: newLat, longitude: newLon };
  }
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
window.getUserLocation = async function (position, auto) {
  const { latitude, longitude } = await window.skewLocation(position.coords.latitude, position.coords.longitude)
  sessionStorage.setItem("lat", latitude)
  sessionStorage.setItem("lon", longitude)
  document.cookie = "lat=" + latitude + "; path=/";
  document.cookie = "lon=" + longitude + "; path=/";
  if (auto) window.location.reload();
}
if (location.pathname != "/new" && (!document.cookie.includes("lat") || !document.cookie.includes("lon"))) {
  navigator.geolocation.getCurrentPosition(async function (a) { await getUserLocation(a, true) });
}

window.formatDistance = function(distanceKm) {
  function getCookie(name) {
    const v = document.cookie.match('(^|;) ?' + name + '=([^;]*)(;|$)');
    return v ? decodeURIComponent(v[2]) : null;
  }
  
  const units = getCookie('units') || 'metric';
  
  if (units === 'imperial') {
    const miles = distanceKm * 0.621371;
    if (miles < 0.1) {
      const feet = miles * 5280;
      return `${feet.toFixed(0)}ft`;
    }
    return `${miles.toFixed(2)}mi`;
  } else {
    if (distanceKm < 0.1) {
      const meters = distanceKm * 1000;
      return `${meters.toFixed(0)}m`;
    }
    return `${distanceKm.toFixed(2)}km`;
  }
};

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
