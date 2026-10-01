/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { detectRealWorldLocationIntent, type RealWorldLocationIntent } from './Google3DTileService';

export type LocationCastingArchetype =
  | 'ballistics_proving_ground'
  | 'black_box_soundstage'
  | 'high_speed_motorsport'
  | 'aerospace_flight_test'
  | 'cyberpunk_megacity'
  | 'marine_subsea'
  | 'geological_alpine'
  | 'ancient_archaeological'
  | 'scientific_particle_lab'
  | 'astronomical_cosmic'
  | 'tactical_battlefield'
  | 'modern_architectural_pavilion'
  | 'verdant_wilderness'
  | 'arid_desert_wasteland'
  | 'cinematic_metropolitan'
  | 'planetary_surface'
  | 'explicit_landmark';

export interface CastedLocation {
  isRealWorld: boolean;
  landmarkName: string;
  lat: number;
  lng: number;
  elevation: number;
  formattedAddress?: string;
  archetype: LocationCastingArchetype;
  rationale: string;
  suggestedEnvironment?: {
    skybox?: string;
    lighting?: string;
    groundPreset?: string;
    clayPreset?: string;
  };
  suggestedCamera?: {
    position?: [number, number, number];
    target?: [number, number, number];
    fov?: number;
  };
}

interface ArchetypeDefinition {
  archetype: LocationCastingArchetype;
  primaryLocation: {
    name: string;
    lat: number;
    lng: number;
    elevation: number;
    address: string;
  };
  secondaryLocation?: {
    name: string;
    lat: number;
    lng: number;
    elevation: number;
    address: string;
  };
  keywords: RegExp;
  themes?: string[];
  rationaleTemplate: (prompt: string, locName: string) => string;
  environment: {
    skybox: string;
    lighting: string;
    clayPreset: string;
  };
}

const ARCHETYPE_DEFINITIONS: ArchetypeDefinition[] = [
  // 1. Ballistics & High-Velocity Optical Impacts (e.g., bullet through glass, driving range)
  {
    archetype: 'ballistics_proving_ground',
    primaryLocation: {
      name: 'Angeles Shooting Ranges & Proving Ground, CA',
      lat: 34.3094,
      lng: -118.3995,
      elevation: 420.0,
      address: '12651 Little Tujunga Canyon Rd, Lake View Terrace, CA 91342'
    },
    secondaryLocation: {
      name: 'Topgolf Driving Range & Ballistics Facility, Las Vegas, NV',
      lat: 36.1097,
      lng: -115.1638,
      elevation: 620.0,
      address: '4627 Koval Ln, Las Vegas, NV 89109'
    },
    keywords: /\b(?:bullet|glass\s*shatter|shatter(?:ed|ing)?|ballistic(?:s)?|supersonic|projectile|rifle|gun|firing\s*range|driving\s*range|golf\s*range|target\s*practice|impact\s*test|fracture|voronoi\s*shards?)\b/i,
    themes: ['glass_shatter'],
    rationaleTemplate: (prompt, locName) =>
      /\bdriving\s*range|golf\b/i.test(prompt)
        ? `Creatively cast to ${locName} for high-velocity trajectory and optical impact testing.`
        : `Creatively cast to ${locName} in the San Gabriel foothills for supersonic projectile & fracture simulation.`,
    environment: {
      skybox: 'studio',
      lighting: 'cinematic_dual_rim',
      clayPreset: 'slate-graphite'
    }
  },

  // 2. Black Background, Dark Void, Soundstages, and Theatrical Cycs
  {
    archetype: 'black_box_soundstage',
    primaryLocation: {
      name: 'Pinewood Studios (Stage D / 007 Soundstage), UK',
      lat: 51.5478,
      lng: -0.5342,
      elevation: 45.0,
      address: 'Pinewood Rd, Iver Heath, Slough SL0 0NH, United Kingdom'
    },
    secondaryLocation: {
      name: 'Sony Pictures Studios Stage 15, Culver City, CA',
      lat: 34.0205,
      lng: -118.3967,
      elevation: 28.0,
      address: '10202 W Washington Blvd, Culver City, CA 90232'
    },
    keywords: /\b(?:black\s*background|dark\s*background|black\s*tc|stage\s*with\s*black|black\s*box|soundstage|cyclorama|dark\s*void|onyx\s*pedestal|black\s*stage|studio\s*stage|theatre\s*stage|acoustic\s*stage|product\s*reveal)\b/i,
    themes: ['universal_scene'],
    rationaleTemplate: (_prompt, locName) =>
      `Creatively cast to ${locName}, world-renowned cinematic soundstage with blackened acoustic cyclorama.`,
    environment: {
      skybox: 'studio',
      lighting: 'cinematic_dual_rim',
      clayPreset: 'onyx'
    }
  },

  // 3. High-Speed Motorsport & Automotive Dynamics
  {
    archetype: 'high_speed_motorsport',
    primaryLocation: {
      name: 'Nürburgring Nordschleife Carousel, Germany',
      lat: 50.3356,
      lng: 6.9475,
      elevation: 620.0,
      address: 'Otto-Flimm-Straße, 53520 Nürburg, Germany'
    },
    secondaryLocation: {
      name: 'Bonneville Salt Flats International Speedway, UT',
      lat: 40.7997,
      lng: -113.8569,
      elevation: 1282.0,
      address: 'Tooele County, UT 84083'
    },
    keywords: /\b(?:car|supercar|hypercar|motorsport|racing|drift(?:ing)?|asphalt|vehicle|engine|track|speedway|grand\s*prix|circuit|formula)\b/i,
    themes: ['flight'],
    rationaleTemplate: (_prompt, locName) =>
      `Creatively cast to ${locName} for high-g lateral cornering and telemetry validation.`,
    environment: {
      skybox: 'golden_hour',
      lighting: 'daylight',
      clayPreset: 'warm-architectural-clay'
    }
  },

  // 4. Aerospace, Cockpit & Supersonic Flight
  {
    archetype: 'aerospace_flight_test',
    primaryLocation: {
      name: 'Edwards Air Force Base (Rogers Dry Lake), CA',
      lat: 34.9055,
      lng: -117.8837,
      elevation: 702.0,
      address: 'Kern County, California'
    },
    secondaryLocation: {
      name: 'Mojave Air and Space Port, CA',
      lat: 35.0589,
      lng: -118.1519,
      elevation: 851.0,
      address: '1434 Flightline, Mojave, CA 93501'
    },
    keywords: /\b(?:aircraft|fighter\s*jet|airplane|cockpit|aerospace|dogfight|contrail|mach|supersonic\s*flight|stealth|wing|tailfin|afterburner|f-?16|f-?22|f-?35)\b/i,
    themes: ['flight'],
    rationaleTemplate: (_prompt, locName) =>
      `Creatively cast to ${locName}, premier flight test center for high-mach aerospace experimentation.`,
    environment: {
      skybox: 'daylight',
      lighting: 'daylight',
      clayPreset: 'warm-clay'
    }
  },

  // 5. Cyberpunk, Neon & Futuristic Tech
  {
    archetype: 'cyberpunk_megacity',
    primaryLocation: {
      name: 'Shibuya Crossing & Dogenzaka, Tokyo, Japan',
      lat: 35.6595,
      lng: 139.7004,
      elevation: 20.0,
      address: '1 Chome Dogenzaka, Shibuya City, Tokyo 150-0043, Japan'
    },
    secondaryLocation: {
      name: 'Akihabara Electric Town, Tokyo, Japan',
      lat: 35.6983,
      lng: 139.7731,
      elevation: 6.0,
      address: 'Sotokanda, Chiyoda City, Tokyo 101-0021, Japan'
    },
    keywords: /\b(?:cyberpunk|neon|synthwave|futuristic|hologram|android|mecha|cyber|dystopia|scifi|sci-fi|high-tech|tokyo\s*night)\b/i,
    themes: ['universal_scene', 'city'],
    rationaleTemplate: (_prompt, locName) =>
      `Creatively cast to ${locName}, iconic neon-saturated cybernetic intersection.`,
    environment: {
      skybox: 'cyberpunk',
      lighting: 'cyberpunk',
      clayPreset: 'slate-graphite'
    }
  },

  // 6. Subsea, Ocean & Aquatic Fluid Dynamics
  {
    archetype: 'marine_subsea',
    primaryLocation: {
      name: 'Monterey Bay Submarine Canyon, CA',
      lat: 36.6002,
      lng: -121.8947,
      elevation: -50.0,
      address: 'Monterey Bay National Marine Sanctuary, CA'
    },
    secondaryLocation: {
      name: 'Great Barrier Reef Marine Sanctuary, Australia',
      lat: -16.9203,
      lng: 145.7710,
      elevation: 2.0,
      address: 'Coral Sea, Queensland, Australia'
    },
    keywords: /\b(?:ocean|underwater|sea|marine|subsea|aquatic|coral|trench|whale|submarine|fluid|water\s*surface|waves?)\b/i,
    themes: ['nature_atmosphere'],
    rationaleTemplate: (_prompt, locName) =>
      `Creatively cast to ${locName} for abyssal marine bathymetry and hydrodynamics.`,
    environment: {
      skybox: 'daylight',
      lighting: 'daylight',
      clayPreset: 'matte-limestone'
    }
  },

  // 7. Alpine, Mountains & Geological Formations
  {
    archetype: 'geological_alpine',
    primaryLocation: {
      name: 'The Matterhorn, Zermatt, Switzerland',
      lat: 45.9763,
      lng: 7.6586,
      elevation: 4478.0,
      address: '3920 Zermatt, Switzerland'
    },
    secondaryLocation: {
      name: 'Mount Rainier National Park, WA',
      lat: 46.8523,
      lng: -121.7603,
      elevation: 4392.0,
      address: 'Pierce County, WA'
    },
    keywords: /\b(?:mountain|alpine|peak|summit|cliff|glacier|volcano|rocky|ridge|matterhorn|himalaya|alps|granite|rock\s*face)\b/i,
    themes: ['worldbuilder', 'nature_atmosphere'],
    rationaleTemplate: (_prompt, locName) =>
      `Creatively cast to ${locName} for sheer pyramidal horn relief and glacial erosion modeling.`,
    environment: {
      skybox: 'daylight',
      lighting: 'daylight',
      clayPreset: 'slate-monolith'
    }
  },

  // 8. Ancient Architecture, Monuments & Ruins
  {
    archetype: 'ancient_archaeological',
    primaryLocation: {
      name: 'The Colosseum & Roman Forum, Rome, Italy',
      lat: 41.8902,
      lng: 12.4922,
      elevation: 22.0,
      address: 'Piazza del Colosseo, 1, 00184 Roma RM, Italy'
    },
    secondaryLocation: {
      name: 'Pyramids of Giza & Sphinx, Egypt',
      lat: 29.9792,
      lng: 31.1342,
      elevation: 60.0,
      address: 'Al Haram, Giza Governorate, Egypt'
    },
    keywords: /\b(?:ancient|ruins?|temple|colosseum|pyramid|roman|greek|parthenon|monument|classical|stone\s*pillar|pedestal|obelisk)\b/i,
    themes: ['architecture'],
    rationaleTemplate: (_prompt, locName) =>
      `Creatively cast to ${locName} for monumental classical masonry and historical photorealism.`,
    environment: {
      skybox: 'golden_hour',
      lighting: 'golden_hour',
      clayPreset: 'warm-architectural-clay'
    }
  },

  // 9. Particle Physics, Molecular, Quantum & Laboratories
  {
    archetype: 'scientific_particle_lab',
    primaryLocation: {
      name: 'CERN Large Hadron Collider, Geneva, Switzerland',
      lat: 46.2330,
      lng: 6.0557,
      elevation: 440.0,
      address: 'Esplanade des Particules 1, 1217 Meyrin, Switzerland'
    },
    secondaryLocation: {
      name: 'Fermilab National Accelerator Laboratory, Batavia, IL',
      lat: 41.8384,
      lng: -88.2562,
      elevation: 228.0,
      address: 'Kirk Rd and Pine St, Batavia, IL 60510'
    },
    keywords: /\b(?:molecule|molecular|particle|quantum|atom|atomic|dna|rna|protein|collider|cern|physics\s*lab|fusion|laser|subatomic)\b/i,
    themes: ['molecular'],
    rationaleTemplate: (_prompt, locName) =>
      `Creatively cast to ${locName}, the world's flagship high-energy particle physics complex.`,
    environment: {
      skybox: 'studio',
      lighting: 'cinematic_dual_rim',
      clayPreset: 'pure-bone'
    }
  },

  // 10. Astronomical, Celestial & Observatories
  {
    archetype: 'astronomical_cosmic',
    primaryLocation: {
      name: 'Mauna Kea Summit Observatories, Hawaii',
      lat: 19.8207,
      lng: -155.4681,
      elevation: 4205.0,
      address: 'Mauna Kea Access Rd, Hilo, HI 96720'
    },
    secondaryLocation: {
      name: 'ALMA Radio Telescope Array, Atacama Desert, Chile',
      lat: -23.0293,
      lng: -67.7550,
      elevation: 5058.0,
      address: 'Chajnantor Plateau, Atacama Desert, Chile'
    },
    keywords: /\b(?:space|astronomy|cosmic|galaxy|nebula|orbit|planet(?:s|ary)?|solar\s*system|telescope|deep\s*sky|constellation|saturn|jupiter|mars)\b/i,
    themes: ['solar-system'],
    rationaleTemplate: (_prompt, locName) =>
      `Creatively cast to ${locName}, the premier high-altitude optical clear-sky station on Earth.`,
    environment: {
      skybox: 'night',
      lighting: 'night',
      clayPreset: 'slate-graphite'
    }
  },

  // 11. Tactical Battlefield & Historic Conflict
  {
    archetype: 'tactical_battlefield',
    primaryLocation: {
      name: 'Lexington Battle Green, Massachusetts',
      lat: 42.4473,
      lng: -71.2272,
      elevation: 64.0,
      address: '1625 Massachusetts Ave, Lexington, MA 02420'
    },
    secondaryLocation: {
      name: 'Normandy Pointe du Hoc, France',
      lat: 49.3949,
      lng: -0.9892,
      elevation: 30.0,
      address: '14450 Cricqueville-en-Bessin, France'
    },
    keywords: /\b(?:battle|battlefield|war|conflict|soldiers?|militia|regiment|formation|tactical|lexington|normandy|combat)\b/i,
    themes: ['battlefield'],
    rationaleTemplate: (_prompt, locName) =>
      `Creatively cast to ${locName} for historical terrain grounding and tactical formation choreography.`,
    environment: {
      skybox: 'daylight',
      lighting: 'daylight',
      clayPreset: 'terracotta'
    }
  },

  // 12. Modern Architectural Pavilions & Interior Living Spaces
  {
    archetype: 'modern_architectural_pavilion',
    primaryLocation: {
      name: 'Fallingwater (Frank Lloyd Wright), Mill Run, PA',
      lat: 39.9063,
      lng: -79.4678,
      elevation: 395.0,
      address: '1491 Mill Run Rd, Mill Run, PA 15464'
    },
    secondaryLocation: {
      name: 'The Bauhaus Building, Dessau, Germany',
      lat: 51.8398,
      lng: 12.2275,
      elevation: 60.0,
      address: 'Gropiusallee 38, 06846 Dessau-Roßlau, Germany'
    },
    keywords: /\b(?:interior|living\s*room|modern\s*house|villa|pavilion|gallery|museum|architecture|concrete\s*home|cantilever|furniture)\b/i,
    themes: ['architecture'],
    rationaleTemplate: (_prompt, locName) =>
      `Creatively cast to ${locName} for masterclass organic architecture and cantilevered structural dialogue.`,
    environment: {
      skybox: 'golden_hour',
      lighting: 'golden_hour',
      clayPreset: 'warm-architectural-clay'
    }
  },

  // 13. Verdant Forest, Old Growth & Wilderness
  {
    archetype: 'verdant_wilderness',
    primaryLocation: {
      name: 'Redwood National & State Parks, CA',
      lat: 41.2132,
      lng: -124.0046,
      elevation: 150.0,
      address: 'Humboldt County, CA'
    },
    secondaryLocation: {
      name: 'Muir Woods National Monument, CA',
      lat: 37.8970,
      lng: -122.5811,
      elevation: 95.0,
      address: '1 Muir Woods Rd, Mill Valley, CA 94941'
    },
    keywords: /\b(?:forest|trees?|woods|jungle|rainforest|meadow|foliage|redwoods?|sequoia|swamp|marsh|canopy)\b/i,
    themes: ['nature_atmosphere', 'worldbuilder'],
    rationaleTemplate: (_prompt, locName) =>
      `Creatively cast to ${locName} for towering ancient canopy and complex natural biome lighting.`,
    environment: {
      skybox: 'daylight',
      lighting: 'daylight',
      clayPreset: 'warm-clay'
    }
  },

  // 14. Arid Desert, Dunes & Wasteland
  {
    archetype: 'arid_desert_wasteland',
    primaryLocation: {
      name: 'Death Valley Badwater Basin & Zabriskie Point, CA',
      lat: 36.2503,
      lng: -116.8258,
      elevation: -86.0,
      address: 'Inyo County, CA'
    },
    secondaryLocation: {
      name: 'Monument Valley Navajo Tribal Park, UT/AZ',
      lat: 36.9980,
      lng: -110.0985,
      elevation: 1600.0,
      address: 'Indn Route 42, Oljato-Monument Valley, UT'
    },
    keywords: /\b(?:desert|dunes?|sand|wasteland|canyon|arid|badlands|sahara|mesa|plateau|oasis)\b/i,
    themes: ['worldbuilder'],
    rationaleTemplate: (_prompt, locName) =>
      `Creatively cast to ${locName} for extreme thermal topography and sculpted mineral evaporite patterns.`,
    environment: {
      skybox: 'golden_hour',
      lighting: 'golden_hour',
      clayPreset: 'terracotta'
    }
  },

  // 15. Cinematic Metropolitan & Urban Waterfront (Default Fallback)
  {
    archetype: 'cinematic_metropolitan',
    primaryLocation: {
      name: 'San Francisco Downtown & Ferry Building, CA',
      lat: 37.7955,
      lng: -122.3937,
      elevation: 3.5,
      address: '1 Ferry Building, San Francisco, CA 94111'
    },
    secondaryLocation: {
      name: 'Times Square & Midtown Broadway, New York, NY',
      lat: 40.7580,
      lng: -73.9855,
      elevation: 15.0,
      address: 'Broadway & 7th Ave, New York, NY 10036'
    },
    keywords: /\b(?:city|urban|downtown|skyscraper|street|metropolis|waterfront|plaza|avenue|skyline)\b/i,
    themes: ['city', 'universal_scene'],
    rationaleTemplate: (_prompt, locName) =>
      `Creatively cast to ${locName} for high-density architectural perspective and geospatial grounding.`,
    environment: {
      skybox: 'golden_hour',
      lighting: 'daylight',
      clayPreset: 'warm-clay'
    }
  }
];

export class CreativeLocationCastingService {
  private static instance: CreativeLocationCastingService;

  public static getInstance(): CreativeLocationCastingService {
    if (!CreativeLocationCastingService.instance) {
      CreativeLocationCastingService.instance = new CreativeLocationCastingService();
    }
    return CreativeLocationCastingService.instance;
  }

  /**
   * Creatively casts ANY 3D scene prompt to an authentic real-world location on Earth.
   * If the prompt explicitly mentions a real-world location, that location is respected directly.
   * Otherwise, the physical, thematic, and cinematic semantics are analyzed to cast the scene
   * into an evocative real-world venue (e.g. driving range for bullets, soundstage for black backgrounds).
   */
  public castLocation(
    prompt: string,
    options?: {
      theme?: string;
      docTitle?: string;
      docContent?: string;
      existingAnchor?: any;
    }
  ): CastedLocation {
    const combined = `${prompt} ${options?.docTitle || ''} ${options?.docContent || ''}`.trim();

    // 1. Check if the prompt explicitly targets a known landmark or explicit coordinates
    const explicitIntent: RealWorldLocationIntent | undefined = detectRealWorldLocationIntent(prompt, {
      docTitle: options?.docTitle,
      docContent: options?.docContent
    });

    if (explicitIntent && explicitIntent.isRealWorld) {
      return {
        isRealWorld: true,
        landmarkName: explicitIntent.landmarkName,
        lat: explicitIntent.lat,
        lng: explicitIntent.lng,
        elevation: explicitIntent.elevation,
        archetype: 'explicit_landmark',
        rationale: `Direct real-world landmark request: ${explicitIntent.landmarkName}`,
        suggestedEnvironment: {
          skybox: 'golden_hour',
          lighting: 'daylight',
          clayPreset: 'warm-clay'
        }
      };
    }

    // 1b. Check if the prompt targets an extraterrestrial planetary body (Mars, Moon, Titan)
    if (/\b(?:mars|martian|rover|jezero|curiosity|perseverance|opportunity|sojourner|moon|lunar\s*surface|planetary\s*surface|red\s*planet)\b/i.test(combined)) {
      return {
        isRealWorld: false,
        landmarkName: 'Jezero Crater, Mars (Perseverance Exploration Site)',
        lat: 18.38,
        lng: 77.58,
        elevation: -2500,
        archetype: 'planetary_surface',
        rationale: 'Extraterrestrial planetary surface: Jezero Crater, Mars (18.38°N, 77.58°E, altitude -2500m on Martian datum)',
        suggestedEnvironment: {
          skybox: 'mars',
          lighting: 'golden_hour',
          clayPreset: 'terracotta'
        }
      };
    }

    // 2. Score archetypes by keyword match count and theme affinity
    let bestMatch: ArchetypeDefinition = ARCHETYPE_DEFINITIONS[ARCHETYPE_DEFINITIONS.length - 1]; // Default metropolitan
    let highestScore = -1;

    for (const def of ARCHETYPE_DEFINITIONS) {
      let score = 0;

      // Theme match bonus
      if (options?.theme && def.themes?.includes(options.theme)) {
        score += 3;
      }

      // Keyword match score
      const keywordMatches = combined.match(def.keywords);
      if (keywordMatches) {
        score += keywordMatches.length * 5;
      }

      if (score > highestScore) {
        highestScore = score;
        bestMatch = def;
      }
    }

    // Choose primary or secondary location
    const useSecondary = /\b(?:secondary|alternate|night|desert|driving|topgolf|las\s*vegas)\b/i.test(prompt);
    const chosenLoc = (useSecondary && bestMatch.secondaryLocation) ? bestMatch.secondaryLocation : bestMatch.primaryLocation;

    return {
      isRealWorld: true,
      landmarkName: chosenLoc.name,
      lat: chosenLoc.lat,
      lng: chosenLoc.lng,
      elevation: chosenLoc.elevation,
      formattedAddress: chosenLoc.address,
      archetype: bestMatch.archetype,
      rationale: bestMatch.rationaleTemplate(combined, chosenLoc.name),
      suggestedEnvironment: {
        skybox: bestMatch.environment.skybox,
        lighting: bestMatch.environment.lighting,
        clayPreset: bestMatch.environment.clayPreset
      }
    };
  }

  public getAllArchetypes(): LocationCastingArchetype[] {
    return ARCHETYPE_DEFINITIONS.map(d => d.archetype);
  }
}

/**
 * Global helper function to cast any 3D prompt creatively.
 */
export function castCreativeLocation(
  prompt: string,
  options?: {
    theme?: string;
    docTitle?: string;
    docContent?: string;
    existingAnchor?: any;
  }
): CastedLocation {
  return CreativeLocationCastingService.getInstance().castLocation(prompt, options);
}
