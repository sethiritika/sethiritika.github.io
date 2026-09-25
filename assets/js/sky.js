(() => {
	'use strict';

	const canvas = document.querySelector('#sky-map');
	const clock = document.querySelector('#sky-time');
	const tooltip = document.querySelector('.constellation-tooltip');
	const data = window.SKY_DATA;
	if (!canvas || !data) return;

	const isSafari = document.documentElement.classList.contains('is-safari');
	const context = canvas.getContext('2d', isSafari ? { alpha: true } : { alpha: true, desynchronized: true });
	const latitude = 28.6139;
	const longitude = 77.2090;
	const startTime = Date.UTC(2000, 4, 16, 18, 30, 0); // 17 May 2000, 00:00 IST
	const simulatedDay = 24 * 60 * 60 * 1000;
	const loopDuration = 120 * 1000;
	const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
	const radians = Math.PI / 180;
	const sinLatitude = Math.sin(latitude * radians);
	const cosLatitude = Math.cos(latitude * radians);
	const colorForIndex = colorIndex => {
		const value = Number(colorIndex);
		if (!Number.isFinite(value)) return '240,243,255';
		if (value < 0) return '178,214,255';
		if (value < 0.5) return '218,231,255';
		if (value < 1.0) return '255,246,224';
		return '255,210,169';
	};
	const preparedStars = data.stars.map(star => ({
		rightAscension: star[0],
		sinDeclination: Math.sin(star[1] * radians),
		cosDeclination: Math.cos(star[1] * radians),
		magnitude: star[2],
		color: colorForIndex(star[3])
	}));
	// Fifteen frames per second keeps the accelerated sky visually continuous
	// without paying for a full star-map projection on every display refresh.
	// Safari gets a slightly gentler cap because its canvas compositing is costlier.
	const frameInterval = isSafari ? 83 : 66;
	let width = 0;
	let height = 0;
	let deviceScale = 1;
	let currentDate = startTime;
	let displayedMinute = null;
	let resizeFrame = 0;
	let lastRenderTime = -Infinity;
	const pointer = { x: 0, y: 0, active: false };

	const normalize = angle => ((angle % 360) + 360) % 360;

	function localSiderealTime(dateMs) {
		const julianDate = dateMs / 86400000 + 2440587.5;
		const centuries = (julianDate - 2451545.0) / 36525;
		const greenwich = 280.46061837
			+ 360.98564736629 * (julianDate - 2451545.0)
			+ 0.000387933 * centuries * centuries
			- centuries * centuries * centuries / 38710000;
		return normalize(greenwich + longitude);
	}

	function horizontalPositionFromTrig(rightAscension, sinDec, cosDec, siderealTime) {
		const hourAngle = (siderealTime - rightAscension) * radians;
		const sinAltitude = sinLatitude * sinDec + cosLatitude * cosDec * Math.cos(hourAngle);
		const altitude = Math.asin(Math.max(-1, Math.min(1, sinAltitude)));
		if (altitude <= 0) return null;

		const cosAltitude = Math.max(0.000001, Math.cos(altitude));
		const sinAzimuth = -cosDec * Math.sin(hourAngle) / cosAltitude;
		const cosAzimuth = (sinDec - Math.sin(altitude) * sinLatitude) / (cosAltitude * cosLatitude);
		const azimuth = normalize(Math.atan2(sinAzimuth, cosAzimuth) / radians);

		return {
			x: azimuth / 360 * width,
			y: height * (-0.035 + (1 - altitude / (Math.PI / 2)) * 0.89),
			altitude: altitude / radians
		};
	}

	function horizontalPosition(rightAscension, declination, siderealTime) {
		const dec = declination * radians;
		return horizontalPositionFromTrig(rightAscension, Math.sin(dec), Math.cos(dec), siderealTime);
	}

	function resize() {
		deviceScale = 1;
		width = window.innerWidth;
		height = window.innerHeight;
		canvas.width = Math.round(width * deviceScale);
		canvas.height = Math.round(height * deviceScale);
		canvas.style.width = `${width}px`;
		canvas.style.height = `${height}px`;
		context.setTransform(deviceScale, 0, 0, deviceScale, 0, 0);
	}

	function drawWrappedSegment(a, b) {
		let ax = a.x;
		let bx = b.x;
		if (Math.abs(ax - bx) > width / 2) {
			if (ax < bx) ax += width;
			else bx += width;
		}
		context.moveTo(ax, a.y);
		context.lineTo(bx, b.y);
		context.moveTo(ax - width, a.y);
		context.lineTo(bx - width, b.y);
	}

	function distanceToSegment(px, py, a, b) {
		const dx = b.x - a.x;
		const dy = b.y - a.y;
		if (dx === 0 && dy === 0) return Math.hypot(px - a.x, py - a.y);
		const amount = Math.max(0, Math.min(1, ((px - a.x) * dx + (py - a.y) * dy) / (dx * dx + dy * dy)));
		return Math.hypot(px - (a.x + amount * dx), py - (a.y + amount * dy));
	}

	function wrappedDistance(a, b) {
		let ax = a.x;
		let bx = b.x;
		if (Math.abs(ax - bx) > width / 2) {
			if (ax < bx) ax += width;
			else bx += width;
		}
		const start = { x: ax, y: a.y };
		const end = { x: bx, y: b.y };
		return Math.min(
			distanceToSegment(pointer.x, pointer.y, start, end),
			distanceToSegment(pointer.x + width, pointer.y, start, end),
			distanceToSegment(pointer.x - width, pointer.y, start, end)
		);
	}

	function drawConstellations(siderealTime) {
		const projected = [];
		let nearest = null;
		for (const constellation of data.constellations) {
			const labelPoints = [];
			const projectedLines = [];
			let proximity = Infinity;
			for (const line of constellation.lines) {
				let previous = null;
				const projectedLine = [];
				for (const coordinate of line) {
					const current = horizontalPosition(coordinate[0], coordinate[1], siderealTime);
					if (current) labelPoints.push(current);
					projectedLine.push(current);
					if (pointer.active && previous && current) proximity = Math.min(proximity, wrappedDistance(previous, current));
					previous = current;
				}
				projectedLines.push(projectedLine);
			}
			const item = { constellation, lines: projectedLines, labelPoints, proximity };
			projected.push(item);
			if (pointer.active && proximity < 82 && (!nearest || proximity < nearest.proximity)) nearest = item;
		}

		context.textAlign = 'center';
		for (const item of projected) {
			const active = item === nearest;
			context.beginPath();
			for (const line of item.lines) {
				for (let index = 1; index < line.length; index += 1) {
					if (line[index - 1] && line[index]) drawWrappedSegment(line[index - 1], line[index]);
				}
			}
			context.lineWidth = active ? 1.6 : 0.7;
			context.strokeStyle = active ? 'rgba(224, 178, 218, 0.68)' : 'rgba(158, 217, 215, 0.16)';
			if (active) {
				context.shadowColor = 'rgba(218, 160, 211, 0.48)';
				context.shadowBlur = 9;
			}
			context.stroke();
			context.shadowBlur = 0;

			if ((item.constellation.rank === 1 || active) && item.labelPoints.length >= 3) {
				const angles = item.labelPoints.map(point => point.x / width * Math.PI * 2);
				const labelAngle = Math.atan2(
					angles.reduce((sum, angle) => sum + Math.sin(angle), 0),
					angles.reduce((sum, angle) => sum + Math.cos(angle), 0)
				);
				const x = normalize(labelAngle / radians) / 360 * width;
				const y = item.labelPoints.reduce((sum, point) => sum + point.y, 0) / item.labelPoints.length;
				context.font = `${active ? 600 : 500} ${active ? 10 : 9}px Source Sans Pro, sans-serif`;
				context.fillStyle = active ? 'rgba(240, 218, 238, 0.82)' : 'rgba(199, 184, 229, 0.36)';
				context.fillText(item.constellation.name.toUpperCase(), x, y - 8);
			}
		}

		if (tooltip) {
			if (nearest) {
				tooltip.textContent = nearest.constellation.name;
				tooltip.style.left = `${Math.min(pointer.x, width - 130)}px`;
				tooltip.style.top = `${Math.min(pointer.y, height - 40)}px`;
				tooltip.classList.add('visible');
			} else {
				tooltip.classList.remove('visible');
			}
		}
	}

	function drawStars(siderealTime) {
		for (const star of preparedStars) {
			const position = horizontalPositionFromTrig(
				star.rightAscension, star.sinDeclination, star.cosDeclination, siderealTime
			);
			if (!position) continue;
			const magnitude = star.magnitude;
			const radius = Math.max(0.45, 2.52 - magnitude * 0.34);
			const alpha = Math.min(1, Math.max(0.32, 1.2 - magnitude * 0.12));
			context.beginPath();
			context.arc(position.x, position.y, radius, 0, Math.PI * 2);
			context.fillStyle = `rgba(${star.color},${alpha})`;
			context.fill();
		}
	}

	function updateClock(dateMs) {
		if (!clock) return;
		const minute = Math.floor(dateMs / 60000);
		if (minute === displayedMinute) return;
		displayedMinute = minute;
		const parts = new Intl.DateTimeFormat('en-GB', {
			timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric',
			hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
		}).formatToParts(new Date(dateMs));
		const part = type => parts.find(item => item.type === type)?.value || '';
		clock.textContent = `${part('day')} ${part('month')} ${part('year')} · ${part('hour')}:${part('minute')} IST`;
	}

	function render(dateMs) {
		currentDate = dateMs;
		context.clearRect(0, 0, width, height);
		const siderealTime = localSiderealTime(dateMs);
		drawConstellations(siderealTime);
		drawStars(siderealTime);
		updateClock(dateMs);
	}

	function animate(now) {
		const paused = document.hidden || document.body.classList.contains('modal-open');
		if (!paused && now - lastRenderTime >= frameInterval) {
			const elapsed = now % loopDuration;
			render(startTime + elapsed / loopDuration * simulatedDay);
			lastRenderTime = now;
		}
		requestAnimationFrame(animate);
	}

	resize();
	if (reduceMotion.matches) render(startTime);
	else requestAnimationFrame(animate);

	window.addEventListener('resize', () => {
		window.cancelAnimationFrame(resizeFrame);
		resizeFrame = window.requestAnimationFrame(() => {
			resize();
			render(currentDate);
		});
	});

	document.addEventListener('visibilitychange', () => {
		if (!document.hidden) {
			render(currentDate);
		}
	});

	window.addEventListener('pointermove', event => {
		pointer.x = event.clientX;
		pointer.y = event.clientY;
		pointer.active = true;
		if (reduceMotion.matches) render(currentDate);
	}, { passive: true });

	document.addEventListener('mouseleave', () => {
		pointer.active = false;
		if (tooltip) tooltip.classList.remove('visible');
		if (reduceMotion.matches) render(currentDate);
	});
})();
