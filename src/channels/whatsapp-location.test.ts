/**
 * Coverage for the outbound `location` operation's payload shaping.
 *
 * The failure this guards against is silent: Baileys types
 * `proto.Message.ILocationMessage` fields as optional, so a payload built with
 * `{ latitude, longitude }` instead of `{ degreesLatitude, degreesLongitude }`
 * type-checks, sends successfully, and renders as a pin at 0,0. Asserting the
 * wire names is the only thing that catches it short of a live send.
 */
import { describe, expect, it } from 'vitest';

import { buildLocationMessage, locationFallbackText } from './whatsapp.js';

describe('buildLocationMessage', () => {
  it('maps coordinates onto the wire names WhatsApp actually encodes', () => {
    expect(buildLocationMessage({ latitude: 32.0853, longitude: 34.7818 })).toEqual({
      location: { degreesLatitude: 32.0853, degreesLongitude: 34.7818 },
    });
  });

  it('carries name and address through as the pin caption lines', () => {
    expect(
      buildLocationMessage({
        latitude: 32.0853,
        longitude: 34.7818,
        name: 'Dizengoff Center',
        address: 'Dizengoff St 50, Tel Aviv',
      }),
    ).toEqual({
      location: {
        degreesLatitude: 32.0853,
        degreesLongitude: 34.7818,
        name: 'Dizengoff Center',
        address: 'Dizengoff St 50, Tel Aviv',
      },
    });
  });

  it('omits empty labels rather than sending blank caption lines', () => {
    const msg = buildLocationMessage({ latitude: 1, longitude: 2, name: '', address: undefined });
    expect(msg.location).not.toHaveProperty('name');
    expect(msg.location).not.toHaveProperty('address');
  });

  it('keeps zero coordinates — null island is a valid pin, and 0 is falsy', () => {
    expect(buildLocationMessage({ latitude: 0, longitude: 0 })).toEqual({
      location: { degreesLatitude: 0, degreesLongitude: 0 },
    });
  });

  it('keeps southern/western hemispheres negative', () => {
    expect(buildLocationMessage({ latitude: -33.8688, longitude: -151.2093 })).toEqual({
      location: { degreesLatitude: -33.8688, degreesLongitude: -151.2093 },
    });
  });
});

describe('locationFallbackText', () => {
  it('is a bare maps link when the pin has no labels', () => {
    expect(locationFallbackText({ latitude: 32.0853, longitude: 34.7818 })).toBe(
      'https://maps.google.com/?q=32.0853,34.7818',
    );
  });

  it('titles the link with whichever labels are present', () => {
    expect(locationFallbackText({ latitude: 1, longitude: 2, name: 'Office' })).toBe(
      'Office\nhttps://maps.google.com/?q=1,2',
    );
    expect(locationFallbackText({ latitude: 1, longitude: 2, name: 'Office', address: 'Main St 1' })).toBe(
      'Office — Main St 1\nhttps://maps.google.com/?q=1,2',
    );
  });
});
