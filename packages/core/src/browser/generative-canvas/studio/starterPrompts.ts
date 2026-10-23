/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Example prompts for the new-chat starter buttons. A button with several examples sends a random one, never the one
 * it sent last, so repeated clicks show different things the app can do. These are only example request texts typed
 * on the user's behalf: nothing routes on them, and the model treats them like any other request.
 */

export interface StarterButton {
    icon: string;
    label: string;
    /** One or more example requests; one is picked per click. */
    prompts: readonly string[];
}

export const STARTER_BUTTONS: readonly StarterButton[] = [
    { icon: '✨', label: 'Interactive App', prompts: ['Build an interactive audio visualizer app with responsive controls'] },
    {
        icon: '🪐',
        label: '3D Scene',
        // A real district in a major city: the request routes to the staged Google 3D Tiles build (prompt-builder.ts),
        // which remeshes and resurfaces every building, applies the real textures and regrows the measured trees.
        // Stays in district mode deliberately (not isolate: true) - that is a different build shape (one structure,
        // no surrounding streets/trees), not a "cleaner" version of this one. "textured" and the mood/sun clause are
        // said outright: textures are the default, and the sky dome, scattering and solar ephemeris are opt-in
        // (AGENTS.md §3.6), so the words must be in the request. 2026-10-21 (user ask): raised and cooled from a full
        // golden hour (~20 deg elevation, a gentler warmth) so shadow regions read less crushed/near-black, and the
        // azimuth is asked from the place's own real solar geometry rather than a fixed number - there is no tool
        // that reads the sun direction baked into the tile imagery itself (investigated: the closest prior work,
        // tile-sun/measured-brdf, is archived and unported), so this is the closest honest approximation, not a
        // measured match. This button's own chosen mood, not a general build default elsewhere.
        // 2026-10-21 (user ask): a dozen impressive town centres, skewed toward New York (5 of 12 - the places this
        // session verified build cleanly: stepped/setback massing from the scan's own heightfield, de-lit textures,
        // and working SB-Veggie trees after this session's native crash fix), each with real street trees so the
        // tree stage has something to show - a deliberate curated set for this quickstart button, not a limit on
        // what a user can type in chat: any place can still be asked for directly, this only narrows the button's
        // own examples.
        prompts: [
            'Build a textured 3D scene of Central Park in New York with its surrounding streets, buildings and trees, at a bright late-day light - a touch higher and less deeply orange than a full golden hour (around 20 degrees of sun elevation, a gentler warm tone, not deep orange), its azimuth set from the real solar geometry of this location, so the direction stays physically plausible, the sun glowing softly through scattered clouds behind it',
            'Build a textured 3D scene of the Flatiron District in New York with its surrounding streets, buildings and trees, at a bright late-day light - a touch higher and less deeply orange than a full golden hour (around 20 degrees of sun elevation, a gentler warm tone, not deep orange), its azimuth set from the real solar geometry of this location, so the direction stays physically plausible, the sun glowing softly through scattered clouds behind it',
            'Build a textured 3D scene of Union Square in New York with its surrounding streets, buildings and trees, at a bright late-day light - a touch higher and less deeply orange than a full golden hour (around 20 degrees of sun elevation, a gentler warm tone, not deep orange), its azimuth set from the real solar geometry of this location, so the direction stays physically plausible, the sun glowing softly through scattered clouds behind it',
            'Build a textured 3D scene of Washington Square Park in New York with its surrounding streets, buildings and trees, at a bright late-day light - a touch higher and less deeply orange than a full golden hour (around 20 degrees of sun elevation, a gentler warm tone, not deep orange), its azimuth set from the real solar geometry of this location, so the direction stays physically plausible, the sun glowing softly through scattered clouds behind it',
            'Build a textured 3D scene of Bryant Park in New York with its surrounding streets, buildings and trees, at a bright late-day light - a touch higher and less deeply orange than a full golden hour (around 20 degrees of sun elevation, a gentler warm tone, not deep orange), its azimuth set from the real solar geometry of this location, so the direction stays physically plausible, the sun glowing softly through scattered clouds behind it',
            'Build a textured 3D scene of Shibuya Crossing in Tokyo with its surrounding streets, buildings and trees, at a bright late-day light - a touch higher and less deeply orange than a full golden hour (around 20 degrees of sun elevation, a gentler warm tone, not deep orange), its azimuth set from the real solar geometry of this location, so the direction stays physically plausible, the sun glowing softly through scattered clouds behind it',
            'Build a textured 3D scene of Trafalgar Square in London with its surrounding streets, buildings and trees, at a bright late-day light - a touch higher and less deeply orange than a full golden hour (around 20 degrees of sun elevation, a gentler warm tone, not deep orange), its azimuth set from the real solar geometry of this location, so the direction stays physically plausible, the sun glowing softly through scattered clouds behind it',
            'Build a textured 3D scene of Potsdamer Platz in Berlin with its surrounding streets, buildings and trees, at a bright late-day light - a touch higher and less deeply orange than a full golden hour (around 20 degrees of sun elevation, a gentler warm tone, not deep orange), its azimuth set from the real solar geometry of this location, so the direction stays physically plausible, the sun glowing softly through scattered clouds behind it',
            'Build a textured 3D scene of Dam Square in Amsterdam with its surrounding streets, buildings and trees, at a bright late-day light - a touch higher and less deeply orange than a full golden hour (around 20 degrees of sun elevation, a gentler warm tone, not deep orange), its azimuth set from the real solar geometry of this location, so the direction stays physically plausible, the sun glowing softly through scattered clouds behind it',
            'Build a textured 3D scene of Marina Bay in Singapore with its surrounding streets, buildings and trees, at a bright late-day light - a touch higher and less deeply orange than a full golden hour (around 20 degrees of sun elevation, a gentler warm tone, not deep orange), its azimuth set from the real solar geometry of this location, so the direction stays physically plausible, the sun glowing softly through scattered clouds behind it',
            'Build a textured 3D scene of Piazza del Duomo in Milan with its surrounding streets, buildings and trees, at a bright late-day light - a touch higher and less deeply orange than a full golden hour (around 20 degrees of sun elevation, a gentler warm tone, not deep orange), its azimuth set from the real solar geometry of this location, so the direction stays physically plausible, the sun glowing softly through scattered clouds behind it',
            'Build a textured 3D scene of Federation Square in Melbourne with its surrounding streets, buildings and trees, at a bright late-day light - a touch higher and less deeply orange than a full golden hour (around 20 degrees of sun elevation, a gentler warm tone, not deep orange), its azimuth set from the real solar geometry of this location, so the direction stays physically plausible, the sun glowing softly through scattered clouds behind it',
        ],
    },
    {
        icon: '🏛️',
        label: '3D Building',
        // One real building rebuilt procedurally by pipeline G (google_3d_tiles_get_clay with isolate and procedural): survey
        // cameras on the street (and one looking straight down for the roof), metric wall plates from the photo tiles, a
        // facade program read per wall, built natively on the vector massing. The first 8 are the curated cast-iron/masonry
        // set this button shipped with (2026-10-22), each verified to build cleanly (strong, repeating window bays the
        // facade reading does best on; Haughwout first, where G was measured). 2026-10-23 (user ask): widened to about 160
        // world landmarks spanning every inhabited continent, picked at random per click like the rest of this button.
        // Honest caveat, not yet filtered out: G's survey+wall-plate model reads openings in a flat-ish facade (windows,
        // arches, bays); a bridge, a freestanding statue, a lattice/observation tower, or an open stone ruin or pyramid has
        // no such facade; a build of one of those tends to a near-featureless clay mass rather than a detailed procedural
        // rebuild, even though the place itself geocodes and stages fine. Kept in the list because the user asked for the
        // whole set and any of them can still be asked for in chat either way; narrowing the button to only the buildings
        // G reads well is a later, separate decision, not done here.
        // 2026-10-22: Wainwright (St. Louis) dropped - Places resolves it to the Wainwright State Office Building next door.
        prompts: [
            'Build a procedural 3D building of the E.V. Haughwout Building at 488 Broadway, New York: isolate it and rebuild it from scratch with the procedural pipeline, its arched windows, columns, cornices and shop fronts read from a survey of the photo tiles',
            'Build a procedural 3D building of the Puck Building at 295 Lafayette Street, New York: isolate it and rebuild it from scratch with the procedural pipeline, its arched windows, piers, cornices and shop fronts read from a survey of the photo tiles',
            'Build a procedural 3D building of the Gilsey House at 1200 Broadway, New York: isolate it and rebuild it from scratch with the procedural pipeline, its windows, columns, cornices and shop fronts read from a survey of the photo tiles',
            'Build a procedural 3D building of the Flatiron Building at 175 Fifth Avenue, New York: isolate it and rebuild it from scratch with the procedural pipeline, its windows, bands, cornices and shop fronts read from a survey of the photo tiles',
            'Build a procedural 3D building of The Rookery at 209 South LaSalle Street, Chicago: isolate it and rebuild it from scratch with the procedural pipeline, its arched windows, piers, cornices and shop fronts read from a survey of the photo tiles',
            'Build a procedural 3D building of the Gunther Building at 469 Broome Street, New York: isolate it and rebuild it from scratch with the procedural pipeline, its windows, columns, cornices and shop fronts read from a survey of the photo tiles',
            'Build a procedural 3D building of the Guaranty Building at 140 Pearl Street, Buffalo: isolate it and rebuild it from scratch with the procedural pipeline, its windows, piers, cornice and shop fronts read from a survey of the photo tiles',
            'Build a procedural 3D building of the Bradbury Building at 304 South Broadway, Los Angeles: isolate it and rebuild it from scratch with the procedural pipeline, its arched windows, bands, cornice and shop fronts read from a survey of the photo tiles',
            'Build a procedural 3D building of the Empire State Building at 350 Fifth Avenue, New York: isolate it and rebuild it from scratch with the procedural pipeline, its window bays, setbacks and facade massing read from a survey of the photo tiles',
            'Build a procedural 3D building of the Chrysler Building at 405 Lexington Avenue, New York: isolate it and rebuild it from scratch with the procedural pipeline, its window bays, setbacks and facade massing read from a survey of the photo tiles',
            'Build a procedural 3D building of One World Trade Center at 285 Fulton Street, New York: isolate it and rebuild it from scratch with the procedural pipeline, its window bays, setbacks and facade massing read from a survey of the photo tiles',
            'Build a procedural 3D building of Rockefeller Center at 45 Rockefeller Plaza, New York: isolate it and rebuild it from scratch with the procedural pipeline, its window bays, setbacks and facade massing read from a survey of the photo tiles',
            'Build a procedural 3D building of the Guggenheim Museum at 1071 Fifth Avenue, New York: isolate it and rebuild it from scratch with the procedural pipeline, its windows, cornices, columns and facade detail read from a survey of the photo tiles',
            'Build a procedural 3D building of the Statue of Liberty in Liberty Island, New York: isolate it and rebuild it from scratch with the procedural pipeline, its sculptural form and base read from a survey of the photo tiles',
            'Build a procedural 3D building of Brooklyn Bridge in New York: isolate it and rebuild it from scratch with the procedural pipeline, its towers, cables and deck read from a survey of the photo tiles',
            'Build a procedural 3D building of the Manhattan Bridge in New York: isolate it and rebuild it from scratch with the procedural pipeline, its towers, cables and deck read from a survey of the photo tiles',
            'Build a procedural 3D building of the White House at 1600 Pennsylvania Avenue NW, Washington, D.C.: isolate it and rebuild it from scratch with the procedural pipeline, its windows, balconies, cornices and facade ornament read from a survey of the photo tiles',
            'Build a procedural 3D building of the United States Capitol in First Street SE, Washington, D.C.: isolate it and rebuild it from scratch with the procedural pipeline, its dome, columns and portico read from a survey of the photo tiles',
            'Build a procedural 3D building of the Lincoln Memorial in Washington, D.C.: isolate it and rebuild it from scratch with the procedural pipeline, its columns, pediment and portico read from a survey of the photo tiles',
            'Build a procedural 3D building of the Washington Monument in Washington, D.C.: isolate it and rebuild it from scratch with the procedural pipeline, its form and surface detail read from a survey of the photo tiles',
            'Build a procedural 3D building of the Golden Gate Bridge in San Francisco: isolate it and rebuild it from scratch with the procedural pipeline, its towers, cables and deck read from a survey of the photo tiles',
            'Build a procedural 3D building of the Space Needle in Seattle: isolate it and rebuild it from scratch with the procedural pipeline, its lattice ironwork, structural framing and observation levels read from a survey of the photo tiles',
            'Build a procedural 3D building of Willis Tower at 233 South Wacker Drive, Chicago: isolate it and rebuild it from scratch with the procedural pipeline, its window bays, setbacks and facade massing read from a survey of the photo tiles',
            'Build a procedural 3D building of the Gateway Arch in St. Louis: isolate it and rebuild it from scratch with the procedural pipeline, its arch, piers and relief carving read from a survey of the photo tiles',
            'Build a procedural 3D building of Fallingwater in Mill Run, Pennsylvania: isolate it and rebuild it from scratch with the procedural pipeline, its windows, cornices, columns and facade detail read from a survey of the photo tiles',
            'Build a procedural 3D building of Christ the Redeemer in Rio de Janeiro, Brazil: isolate it and rebuild it from scratch with the procedural pipeline, its sculptural form and base read from a survey of the photo tiles',
            'Build a procedural 3D building of Chichen Itza in Yucatan, Mexico: isolate it and rebuild it from scratch with the procedural pipeline, its stepped massing and stonework read from a survey of the photo tiles',
            'Build a procedural 3D building of Machu Picchu in Cusco Region, Peru: isolate it and rebuild it from scratch with the procedural pipeline, its stepped massing and stonework read from a survey of the photo tiles',
            'Build a procedural 3D building of the Pyramid of the Sun at Teotihuacan in Mexico: isolate it and rebuild it from scratch with the procedural pipeline, its stepped massing and stonework read from a survey of the photo tiles',
            'Build a procedural 3D building of the ruins of Palenque in Chiapas, Mexico: isolate it and rebuild it from scratch with the procedural pipeline, its stepped massing and stonework read from a survey of the photo tiles',
            'Build a procedural 3D building of the Tikal temples in Peten, Guatemala: isolate it and rebuild it from scratch with the procedural pipeline, its stepped massing and stonework read from a survey of the photo tiles',
            'Build a procedural 3D building of the Copan ruins in Copan, Honduras: isolate it and rebuild it from scratch with the procedural pipeline, its stepped massing and stonework read from a survey of the photo tiles',
            'Build a procedural 3D building of the Catedral Metropolitana in Mexico City, Mexico: isolate it and rebuild it from scratch with the procedural pipeline, its arched windows, portals, spires and stonework read from a survey of the photo tiles',
            'Build a procedural 3D building of the Palacio de Bellas Artes in Mexico City, Mexico: isolate it and rebuild it from scratch with the procedural pipeline, its windows, cornices, columns and facade detail read from a survey of the photo tiles',
            'Build a procedural 3D building of the Eiffel Tower in Paris, France: isolate it and rebuild it from scratch with the procedural pipeline, its lattice ironwork, structural framing and observation levels read from a survey of the photo tiles',
            'Build a procedural 3D building of Notre-Dame de Paris in Paris, France: isolate it and rebuild it from scratch with the procedural pipeline, its arched windows, portals, spires and stonework read from a survey of the photo tiles',
            'Build a procedural 3D building of the Arc de Triomphe in Paris, France: isolate it and rebuild it from scratch with the procedural pipeline, its arch, piers and relief carving read from a survey of the photo tiles',
            'Build a procedural 3D building of the Louvre Pyramid in Paris, France: isolate it and rebuild it from scratch with the procedural pipeline, its glass panels and steel lattice read from a survey of the photo tiles',
            'Build a procedural 3D building of the Sacre-Coeur Basilica in Paris, France: isolate it and rebuild it from scratch with the procedural pipeline, its arched windows, portals, spires and stonework read from a survey of the photo tiles',
            'Build a procedural 3D building of Mont-Saint-Michel in Normandy, France: isolate it and rebuild it from scratch with the procedural pipeline, its towers, battlements and stonework read from a survey of the photo tiles',
            'Build a procedural 3D building of the Chateau de Chambord in Loir-et-Cher, France: isolate it and rebuild it from scratch with the procedural pipeline, its windows, balconies, cornices and facade ornament read from a survey of the photo tiles',
            'Build a procedural 3D building of the Palace of Versailles in Versailles, France: isolate it and rebuild it from scratch with the procedural pipeline, its windows, balconies, cornices and facade ornament read from a survey of the photo tiles',
            'Build a procedural 3D building of Chartres Cathedral in Chartres, France: isolate it and rebuild it from scratch with the procedural pipeline, its arched windows, portals, spires and stonework read from a survey of the photo tiles',
            'Build a procedural 3D building of Reims Cathedral in Reims, France: isolate it and rebuild it from scratch with the procedural pipeline, its arched windows, portals, spires and stonework read from a survey of the photo tiles',
            'Build a procedural 3D building of Amiens Cathedral in Amiens, France: isolate it and rebuild it from scratch with the procedural pipeline, its arched windows, portals, spires and stonework read from a survey of the photo tiles',
            'Build a procedural 3D building of Strasbourg Cathedral in Strasbourg, France: isolate it and rebuild it from scratch with the procedural pipeline, its arched windows, portals, spires and stonework read from a survey of the photo tiles',
            'Build a procedural 3D building of the Pont du Gard in Nimes, France: isolate it and rebuild it from scratch with the procedural pipeline, its arches, piers and deck read from a survey of the photo tiles',
            'Build a procedural 3D building of the Maison Carree in Nimes, France: isolate it and rebuild it from scratch with the procedural pipeline, its columns, pediment and portico read from a survey of the photo tiles',
            'Build a procedural 3D building of the citadel of Carcassonne in Carcassonne, France: isolate it and rebuild it from scratch with the procedural pipeline, its towers, battlements and stonework read from a survey of the photo tiles',
            'Build a procedural 3D building of the Palace of Westminster and Big Ben in London, United Kingdom: isolate it and rebuild it from scratch with the procedural pipeline, its windows, balconies, cornices and facade ornament read from a survey of the photo tiles',
            'Build a procedural 3D building of Tower Bridge in London, United Kingdom: isolate it and rebuild it from scratch with the procedural pipeline, its towers, cables and deck read from a survey of the photo tiles',
            'Build a procedural 3D building of the Tower of London in London, United Kingdom: isolate it and rebuild it from scratch with the procedural pipeline, its towers, battlements and stonework read from a survey of the photo tiles',
            'Build a procedural 3D building of Buckingham Palace in London, United Kingdom: isolate it and rebuild it from scratch with the procedural pipeline, its windows, balconies, cornices and facade ornament read from a survey of the photo tiles',
            'Build a procedural 3D building of St. Paul\'s Cathedral in London, United Kingdom: isolate it and rebuild it from scratch with the procedural pipeline, its arched windows, portals, spires and stonework read from a survey of the photo tiles',
            'Build a procedural 3D building of Westminster Abbey in London, United Kingdom: isolate it and rebuild it from scratch with the procedural pipeline, its arched windows, portals, spires and stonework read from a survey of the photo tiles',
            'Build a procedural 3D building of Stonehenge in Wiltshire, United Kingdom: isolate it and rebuild it from scratch with the procedural pipeline, its columns, foundations and stonework read from a survey of the photo tiles',
            'Build a procedural 3D building of Edinburgh Castle in Edinburgh, United Kingdom: isolate it and rebuild it from scratch with the procedural pipeline, its towers, battlements and stonework read from a survey of the photo tiles',
            'Build a procedural 3D building of the Clifton Suspension Bridge in Bristol, United Kingdom: isolate it and rebuild it from scratch with the procedural pipeline, its towers, cables and deck read from a survey of the photo tiles',
            'Build a procedural 3D building of the Brandenburg Gate in Berlin, Germany: isolate it and rebuild it from scratch with the procedural pipeline, its arch, piers and relief carving read from a survey of the photo tiles',
            'Build a procedural 3D building of Neuschwanstein Castle in Schwangau, Germany: isolate it and rebuild it from scratch with the procedural pipeline, its towers, battlements and stonework read from a survey of the photo tiles',
            'Build a procedural 3D building of Cologne Cathedral in Cologne, Germany: isolate it and rebuild it from scratch with the procedural pipeline, its arched windows, portals, spires and stonework read from a survey of the photo tiles',
            'Build a procedural 3D building of the Reichstag Building in Berlin, Germany: isolate it and rebuild it from scratch with the procedural pipeline, its dome, columns and portico read from a survey of the photo tiles',
            'Build a procedural 3D building of the Sagrada Familia in Barcelona, Spain: isolate it and rebuild it from scratch with the procedural pipeline, its arched windows, portals, spires and stonework read from a survey of the photo tiles',
            'Build a procedural 3D building of the Alhambra in Granada, Spain: isolate it and rebuild it from scratch with the procedural pipeline, its towers, battlements and stonework read from a survey of the photo tiles',
            'Build a procedural 3D building of the Aqueduct of Segovia in Segovia, Spain: isolate it and rebuild it from scratch with the procedural pipeline, its arches, piers and deck read from a survey of the photo tiles',
            'Build a procedural 3D building of Casa Batllo in Barcelona, Spain: isolate it and rebuild it from scratch with the procedural pipeline, its windows, cornices, columns and facade detail read from a survey of the photo tiles',
            'Build a procedural 3D building of Casa Mila in Barcelona, Spain: isolate it and rebuild it from scratch with the procedural pipeline, its windows, cornices, columns and facade detail read from a survey of the photo tiles',
            'Build a procedural 3D building of the Plaza de Espana in Seville, Spain: isolate it and rebuild it from scratch with the procedural pipeline, its facades, arcades and ornament read from a survey of the photo tiles',
            'Build a procedural 3D building of the Belem Tower in Lisbon, Portugal: isolate it and rebuild it from scratch with the procedural pipeline, its towers, battlements and stonework read from a survey of the photo tiles',
            'Build a procedural 3D building of St. Stephen\'s Cathedral in Vienna, Austria: isolate it and rebuild it from scratch with the procedural pipeline, its arched windows, portals, spires and stonework read from a survey of the photo tiles',
            'Build a procedural 3D building of Schonbrunn Palace in Vienna, Austria: isolate it and rebuild it from scratch with the procedural pipeline, its windows, balconies, cornices and facade ornament read from a survey of the photo tiles',
            'Build a procedural 3D building of the Rijksmuseum in Amsterdam, Netherlands: isolate it and rebuild it from scratch with the procedural pipeline, its windows, cornices, columns and facade detail read from a survey of the photo tiles',
            'Build a procedural 3D building of the Anne Frank House in Amsterdam, Netherlands: isolate it and rebuild it from scratch with the procedural pipeline, its windows, cornices, columns and facade detail read from a survey of the photo tiles',
            'Build a procedural 3D building of the Atomium in Brussels, Belgium: isolate it and rebuild it from scratch with the procedural pipeline, its lattice ironwork, structural framing and observation levels read from a survey of the photo tiles',
            'Build a procedural 3D building of the Grand Place in Brussels, Belgium: isolate it and rebuild it from scratch with the procedural pipeline, its facades, arcades and ornament read from a survey of the photo tiles',
            'Build a procedural 3D building of Villa Savoye in Poissy, France: isolate it and rebuild it from scratch with the procedural pipeline, its windows, cornices, columns and facade detail read from a survey of the photo tiles',
            'Build a procedural 3D building of the Colosseum in Rome, Italy: isolate it and rebuild it from scratch with the procedural pipeline, its columns, foundations and stonework read from a survey of the photo tiles',
            'Build a procedural 3D building of the Pantheon in Rome, Italy: isolate it and rebuild it from scratch with the procedural pipeline, its dome, columns and portico read from a survey of the photo tiles',
            'Build a procedural 3D building of St. Peter\'s Basilica in Vatican City: isolate it and rebuild it from scratch with the procedural pipeline, its dome, columns and portico read from a survey of the photo tiles',
            'Build a procedural 3D building of the Leaning Tower of Pisa in Pisa, Italy: isolate it and rebuild it from scratch with the procedural pipeline, its arcaded galleries, carved stonework and tapering shaft read from a survey of the photo tiles',
            'Build a procedural 3D building of the Florence Cathedral (Duomo) in Florence, Italy: isolate it and rebuild it from scratch with the procedural pipeline, its arched windows, portals, spires and stonework read from a survey of the photo tiles',
            'Build a procedural 3D building of the Milan Cathedral (Duomo) in Milan, Italy: isolate it and rebuild it from scratch with the procedural pipeline, its arched windows, portals, spires and stonework read from a survey of the photo tiles',
            'Build a procedural 3D building of St. Mark\'s Basilica in Venice, Italy: isolate it and rebuild it from scratch with the procedural pipeline, its arched windows, portals, spires and stonework read from a survey of the photo tiles',
            'Build a procedural 3D building of the Rialto Bridge in Venice, Italy: isolate it and rebuild it from scratch with the procedural pipeline, its arches, piers and deck read from a survey of the photo tiles',
            'Build a procedural 3D building of the Trevi Fountain in Rome, Italy: isolate it and rebuild it from scratch with the procedural pipeline, its windows, cornices, columns and facade detail read from a survey of the photo tiles',
            'Build a procedural 3D building of Castel Sant\'Angelo in Rome, Italy: isolate it and rebuild it from scratch with the procedural pipeline, its towers, battlements and stonework read from a survey of the photo tiles',
            'Build a procedural 3D building of the Roman Forum in Rome, Italy: isolate it and rebuild it from scratch with the procedural pipeline, its columns, foundations and stonework read from a survey of the photo tiles',
            'Build a procedural 3D building of the Arch of Constantine in Rome, Italy: isolate it and rebuild it from scratch with the procedural pipeline, its arch, piers and relief carving read from a survey of the photo tiles',
            'Build a procedural 3D building of the Arch of Titus in Rome, Italy: isolate it and rebuild it from scratch with the procedural pipeline, its arch, piers and relief carving read from a survey of the photo tiles',
            'Build a procedural 3D building of the Parthenon on the Acropolis of Athens in Athens, Greece: isolate it and rebuild it from scratch with the procedural pipeline, its columns, foundations and stonework read from a survey of the photo tiles',
            'Build a procedural 3D building of Prague Castle in Prague, Czech Republic: isolate it and rebuild it from scratch with the procedural pipeline, its towers, battlements and stonework read from a survey of the photo tiles',
            'Build a procedural 3D building of the Charles Bridge in Prague, Czech Republic: isolate it and rebuild it from scratch with the procedural pipeline, its arches, piers and deck read from a survey of the photo tiles',
            'Build a procedural 3D building of St. Vitus Cathedral in Prague, Czech Republic: isolate it and rebuild it from scratch with the procedural pipeline, its arched windows, portals, spires and stonework read from a survey of the photo tiles',
            'Build a procedural 3D building of the Hungarian Parliament Building in Budapest, Hungary: isolate it and rebuild it from scratch with the procedural pipeline, its windows, balconies, cornices and facade ornament read from a survey of the photo tiles',
            'Build a procedural 3D building of Buda Castle in Budapest, Hungary: isolate it and rebuild it from scratch with the procedural pipeline, its towers, battlements and stonework read from a survey of the photo tiles',
            'Build a procedural 3D building of Bran Castle in Bran, Romania: isolate it and rebuild it from scratch with the procedural pipeline, its towers, battlements and stonework read from a survey of the photo tiles',
            'Build a procedural 3D building of Peles Castle in Sinaia, Romania: isolate it and rebuild it from scratch with the procedural pipeline, its towers, battlements and stonework read from a survey of the photo tiles',
            'Build a procedural 3D building of Saint Basil\'s Cathedral in Moscow, Russia: isolate it and rebuild it from scratch with the procedural pipeline, its arched windows, portals, spires and stonework read from a survey of the photo tiles',
            'Build a procedural 3D building of the Moscow Kremlin in Moscow, Russia: isolate it and rebuild it from scratch with the procedural pipeline, its towers, battlements and stonework read from a survey of the photo tiles',
            'Build a procedural 3D building of the Winter Palace in Saint Petersburg, Russia: isolate it and rebuild it from scratch with the procedural pipeline, its windows, balconies, cornices and facade ornament read from a survey of the photo tiles',
            'Build a procedural 3D building of the Church of the Savior on Spilled Blood in Saint Petersburg, Russia: isolate it and rebuild it from scratch with the procedural pipeline, its arched windows, portals, spires and stonework read from a survey of the photo tiles',
            'Build a procedural 3D building of the Peter and Paul Fortress in Saint Petersburg, Russia: isolate it and rebuild it from scratch with the procedural pipeline, its towers, battlements and stonework read from a survey of the photo tiles',
            'Build a procedural 3D building of Hallgrimskirkja in Reykjavik, Iceland: isolate it and rebuild it from scratch with the procedural pipeline, its arched windows, portals, spires and stonework read from a survey of the photo tiles',
            'Build a procedural 3D building of Turning Torso in Malmo, Sweden: isolate it and rebuild it from scratch with the procedural pipeline, its window bays, setbacks and facade massing read from a survey of the photo tiles',
            'Build a procedural 3D building of Drottningholm Palace in Stockholm, Sweden: isolate it and rebuild it from scratch with the procedural pipeline, its windows, balconies, cornices and facade ornament read from a survey of the photo tiles',
            'Build a procedural 3D building of Nyhavn in Copenhagen, Denmark: isolate it and rebuild it from scratch with the procedural pipeline, its gabled townhouse facades read from a survey of the photo tiles',
            'Build a procedural 3D building of the Burj Khalifa in Dubai, United Arab Emirates: isolate it and rebuild it from scratch with the procedural pipeline, its window bays, setbacks and facade massing read from a survey of the photo tiles',
            'Build a procedural 3D building of the Burj Al Arab in Dubai, United Arab Emirates: isolate it and rebuild it from scratch with the procedural pipeline, its window bays, setbacks and facade massing read from a survey of the photo tiles',
            'Build a procedural 3D building of the Sheikh Zayed Grand Mosque in Abu Dhabi, United Arab Emirates: isolate it and rebuild it from scratch with the procedural pipeline, its domes, minarets, arched windows and tilework read from a survey of the photo tiles',
            'Build a procedural 3D building of the Hagia Sophia in Istanbul, Turkey: isolate it and rebuild it from scratch with the procedural pipeline, its domes, minarets, arched windows and tilework read from a survey of the photo tiles',
            'Build a procedural 3D building of the Blue Mosque in Istanbul, Turkey: isolate it and rebuild it from scratch with the procedural pipeline, its domes, minarets, arched windows and tilework read from a survey of the photo tiles',
            'Build a procedural 3D building of the Treasury at Petra in Petra, Jordan: isolate it and rebuild it from scratch with the procedural pipeline, its carved classical facade and columns read from a survey of the photo tiles',
            'Build a procedural 3D building of the Great Pyramid of Giza in Giza, Egypt: isolate it and rebuild it from scratch with the procedural pipeline, its stepped massing and stonework read from a survey of the photo tiles',
            'Build a procedural 3D building of the Great Sphinx of Giza in Giza, Egypt: isolate it and rebuild it from scratch with the procedural pipeline, its sculptural form and base read from a survey of the photo tiles',
            'Build a procedural 3D building of the Luxor Temple in Luxor, Egypt: isolate it and rebuild it from scratch with the procedural pipeline, its columns, foundations and stonework read from a survey of the photo tiles',
            'Build a procedural 3D building of the Karnak Temple Complex in Luxor, Egypt: isolate it and rebuild it from scratch with the procedural pipeline, its columns, foundations and stonework read from a survey of the photo tiles',
            'Build a procedural 3D building of the Abu Simbel temples in Aswan, Egypt: isolate it and rebuild it from scratch with the procedural pipeline, its carved classical facade and columns read from a survey of the photo tiles',
            'Build a procedural 3D building of the Hassan II Mosque in Casablanca, Morocco: isolate it and rebuild it from scratch with the procedural pipeline, its domes, minarets, arched windows and tilework read from a survey of the photo tiles',
            'Build a procedural 3D building of the Great Mosque of Djenne in Djenne, Mali: isolate it and rebuild it from scratch with the procedural pipeline, its domes, minarets, arched windows and tilework read from a survey of the photo tiles',
            'Build a procedural 3D building of the Rock-Hewn Churches of Lalibela in Lalibela, Ethiopia: isolate it and rebuild it from scratch with the procedural pipeline, its carved classical facade and columns read from a survey of the photo tiles',
            'Build a procedural 3D building of the Voortrekker Monument in Pretoria, South Africa: isolate it and rebuild it from scratch with the procedural pipeline, its form and surface detail read from a survey of the photo tiles',
            'Build a procedural 3D building of the Taj Mahal in Agra, India: isolate it and rebuild it from scratch with the procedural pipeline, its dome, columns and portico read from a survey of the photo tiles',
            'Build a procedural 3D building of the Qutb Minar in Delhi, India: isolate it and rebuild it from scratch with the procedural pipeline, its arcaded galleries, carved stonework and tapering shaft read from a survey of the photo tiles',
            'Build a procedural 3D building of India Gate in Delhi, India: isolate it and rebuild it from scratch with the procedural pipeline, its arch, piers and relief carving read from a survey of the photo tiles',
            'Build a procedural 3D building of the Gateway of India in Mumbai, India: isolate it and rebuild it from scratch with the procedural pipeline, its arch, piers and relief carving read from a survey of the photo tiles',
            'Build a procedural 3D building of the Lotus Temple in Delhi, India: isolate it and rebuild it from scratch with the procedural pipeline, its shell roofs and podium read from a survey of the photo tiles',
            'Build a procedural 3D building of the Meenakshi Temple in Madurai, India: isolate it and rebuild it from scratch with the procedural pipeline, its towers, carved relief and tiered roofline read from a survey of the photo tiles',
            'Build a procedural 3D building of the Brihadisvara Temple in Thanjavur, India: isolate it and rebuild it from scratch with the procedural pipeline, its towers, carved relief and tiered roofline read from a survey of the photo tiles',
            'Build a procedural 3D building of the Hawa Mahal in Jaipur, India: isolate it and rebuild it from scratch with the procedural pipeline, its windows, balconies, cornices and facade ornament read from a survey of the photo tiles',
            'Build a procedural 3D building of the Amer Fort in Jaipur, India: isolate it and rebuild it from scratch with the procedural pipeline, its towers, battlements and stonework read from a survey of the photo tiles',
            'Build a procedural 3D building of the Mysore Palace in Mysuru, India: isolate it and rebuild it from scratch with the procedural pipeline, its windows, balconies, cornices and facade ornament read from a survey of the photo tiles',
            'Build a procedural 3D building of the Charminar in Hyderabad, India: isolate it and rebuild it from scratch with the procedural pipeline, its arch, piers and relief carving read from a survey of the photo tiles',
            'Build a procedural 3D building of the Victoria Memorial in Kolkata, India: isolate it and rebuild it from scratch with the procedural pipeline, its dome, columns and portico read from a survey of the photo tiles',
            'Build a procedural 3D building of the Forbidden City in Beijing, China: isolate it and rebuild it from scratch with the procedural pipeline, its windows, balconies, cornices and facade ornament read from a survey of the photo tiles',
            'Build a procedural 3D building of the Temple of Heaven in Beijing, China: isolate it and rebuild it from scratch with the procedural pipeline, its towers, carved relief and tiered roofline read from a survey of the photo tiles',
            'Build a procedural 3D building of the Great Wall of China in Beijing, China: isolate it and rebuild it from scratch with the procedural pipeline, its wall sections, watchtowers and stonework read from a survey of the photo tiles',
            'Build a procedural 3D building of the Oriental Pearl Tower in Shanghai, China: isolate it and rebuild it from scratch with the procedural pipeline, its lattice ironwork, structural framing and observation levels read from a survey of the photo tiles',
            'Build a procedural 3D building of Taipei 101 in Taipei, Taiwan: isolate it and rebuild it from scratch with the procedural pipeline, its window bays, setbacks and facade massing read from a survey of the photo tiles',
            'Build a procedural 3D building of the Potala Palace in Lhasa, Tibet: isolate it and rebuild it from scratch with the procedural pipeline, its windows, balconies, cornices and facade ornament read from a survey of the photo tiles',
            'Build a procedural 3D building of Tokyo Tower in Tokyo, Japan: isolate it and rebuild it from scratch with the procedural pipeline, its lattice ironwork, structural framing and observation levels read from a survey of the photo tiles',
            'Build a procedural 3D building of the Tokyo Skytree in Tokyo, Japan: isolate it and rebuild it from scratch with the procedural pipeline, its lattice ironwork, structural framing and observation levels read from a survey of the photo tiles',
            'Build a procedural 3D building of Himeji Castle in Himeji, Japan: isolate it and rebuild it from scratch with the procedural pipeline, its towers, battlements and stonework read from a survey of the photo tiles',
            'Build a procedural 3D building of Osaka Castle in Osaka, Japan: isolate it and rebuild it from scratch with the procedural pipeline, its towers, battlements and stonework read from a survey of the photo tiles',
            'Build a procedural 3D building of Kinkaku-ji, the Golden Pavilion in Kyoto, Japan: isolate it and rebuild it from scratch with the procedural pipeline, its towers, carved relief and tiered roofline read from a survey of the photo tiles',
            'Build a procedural 3D building of the Fushimi Inari Shrine in Kyoto, Japan: isolate it and rebuild it from scratch with the procedural pipeline, its towers, carved relief and tiered roofline read from a survey of the photo tiles',
            'Build a procedural 3D building of Senso-ji Temple in Tokyo, Japan: isolate it and rebuild it from scratch with the procedural pipeline, its towers, carved relief and tiered roofline read from a survey of the photo tiles',
            'Build a procedural 3D building of Todai-ji Temple in Nara, Japan: isolate it and rebuild it from scratch with the procedural pipeline, its towers, carved relief and tiered roofline read from a survey of the photo tiles',
            'Build a procedural 3D building of the Itsukushima Shrine in Miyajima, Japan: isolate it and rebuild it from scratch with the procedural pipeline, its towers, carved relief and tiered roofline read from a survey of the photo tiles',
            'Build a procedural 3D building of Angkor Wat in Siem Reap, Cambodia: isolate it and rebuild it from scratch with the procedural pipeline, its towers, carved relief and tiered roofline read from a survey of the photo tiles',
            'Build a procedural 3D building of Borobudur in Magelang, Indonesia: isolate it and rebuild it from scratch with the procedural pipeline, its stepped massing and stonework read from a survey of the photo tiles',
            'Build a procedural 3D building of the Petronas Towers in Kuala Lumpur, Malaysia: isolate it and rebuild it from scratch with the procedural pipeline, its window bays, setbacks and facade massing read from a survey of the photo tiles',
            'Build a procedural 3D building of Marina Bay Sands in Singapore: isolate it and rebuild it from scratch with the procedural pipeline, its window bays, setbacks and facade massing read from a survey of the photo tiles',
            'Build a procedural 3D building of the Shwedagon Pagoda in Yangon, Myanmar: isolate it and rebuild it from scratch with the procedural pipeline, its towers, carved relief and tiered roofline read from a survey of the photo tiles',
            'Build a procedural 3D building of the Bagan temples in Bagan, Myanmar: isolate it and rebuild it from scratch with the procedural pipeline, its towers, carved relief and tiered roofline read from a survey of the photo tiles',
            'Build a procedural 3D building of Wat Arun in Bangkok, Thailand: isolate it and rebuild it from scratch with the procedural pipeline, its towers, carved relief and tiered roofline read from a survey of the photo tiles',
            'Build a procedural 3D building of the Grand Palace in Bangkok, Thailand: isolate it and rebuild it from scratch with the procedural pipeline, its windows, balconies, cornices and facade ornament read from a survey of the photo tiles',
            'Build a procedural 3D building of the Boudhanath Stupa in Kathmandu, Nepal: isolate it and rebuild it from scratch with the procedural pipeline, its stepped massing and stonework read from a survey of the photo tiles',
            'Build a procedural 3D building of Gyeongbokgung Palace in Seoul, South Korea: isolate it and rebuild it from scratch with the procedural pipeline, its windows, balconies, cornices and facade ornament read from a survey of the photo tiles',
            'Build a procedural 3D building of the N Seoul Tower in Seoul, South Korea: isolate it and rebuild it from scratch with the procedural pipeline, its lattice ironwork, structural framing and observation levels read from a survey of the photo tiles',
            'Build a procedural 3D building of the Registan in Samarkand, Uzbekistan: isolate it and rebuild it from scratch with the procedural pipeline, its facades, arcades and ornament read from a survey of the photo tiles',
            'Build a procedural 3D building of the Sydney Opera House in Sydney, Australia: isolate it and rebuild it from scratch with the procedural pipeline, its shell roofs and podium read from a survey of the photo tiles',
            'Build a procedural 3D building of the Sydney Harbour Bridge in Sydney, Australia: isolate it and rebuild it from scratch with the procedural pipeline, its towers, cables and deck read from a survey of the photo tiles',
        ],
    },
    { icon: '🎬', label: 'Video NLE', prompts: ['Assemble a multi-track video timeline with color grading and title graphics'] },
    {
        icon: '📄',
        label: 'System Spec',
        prompts: [
            'Draft a technical architecture specification with interface invariants',
            'Draft a technical specification for an offline-first note-taking app with end-to-end encrypted sync',
            'Draft a technical specification for a real-time multiplayer game server with lag compensation',
            'Draft a technical specification for a payment service with idempotent retries and an audit log',
            'Draft a technical specification for over-the-air firmware updates on a fleet of smart thermostats',
            'Draft a technical specification for a video transcoding pipeline running on cloud workers',
            'Draft a technical specification for a hospital bed-tracking system with role-based access',
            'Draft a technical specification for a drone delivery fleet’s flight-planning service',
            'Draft a technical specification for a search autocomplete service handling 50,000 queries per second',
            'Draft a technical specification for a library book reservation API with waitlists',
        ],
    },
    {
        icon: '📊',
        label: 'KPI Dashboard',
        prompts: [
            'Dashboard for real-time telemetry metrics and system throughput',
            'Dashboard for an online store: daily revenue, conversion rate, cart abandonment and top products',
            'Dashboard for a hospital emergency department: wait times, bed occupancy and triage levels',
            'Dashboard for a solar farm: power output, panel efficiency, inverter health and weather',
            'Dashboard for a SaaS product: monthly recurring revenue, churn, activation and NPS',
            'Dashboard for a city bike-share network: trips per hour, dock availability and rebalancing',
            'Dashboard for a coffee roastery: batches roasted, roast profiles, green bean inventory and wholesale orders',
            'Dashboard for a customer support team: ticket volume, first response time, resolution rate and satisfaction',
            'Dashboard for a warehouse: orders picked per hour, pick accuracy, backlog and late shipments',
            'Dashboard for a podcast network: downloads, listener retention, ad fill rate and top episodes',
        ],
    },
];

const LAST_KEY = 'sb.starterPrompt.last.';

/**
 * Picks the prompt a starter button sends: a random example, never the one the same button sent last (when it has more
 * than one). `random` returns [0, 1); `storage` remembers the last pick per button and may be absent or throw.
 */
export function pickStarterPrompt(button: StarterButton, random: () => number = Math.random, storage: Pick<Storage, 'getItem' | 'setItem'> | undefined = safeLocalStorage()): string {
    const prompts = button.prompts;
    if (prompts.length === 0) throw new Error(`Starter button "${button.label}" has no prompts.`);
    if (prompts.length === 1) return prompts[0];
    let last: string | null = null;
    try { last = storage?.getItem(LAST_KEY + button.label) ?? null; } catch { last = null; }
    const choices = prompts.filter(p => p !== last);
    const pick = choices[Math.min(choices.length - 1, Math.floor(random() * choices.length))];
    try { storage?.setItem(LAST_KEY + button.label, pick); } catch { /* storage unavailable: repeats are only less unlikely */ }
    return pick;
}

function safeLocalStorage(): Storage | undefined {
    try { return typeof window !== 'undefined' ? window.localStorage : undefined; } catch { return undefined; }
}
