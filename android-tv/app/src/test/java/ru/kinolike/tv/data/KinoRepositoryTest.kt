package ru.kinolike.tv.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class KinoRepositoryTest {
    @Test
    fun `server URL is normalized`() {
        assertEquals("https://kino.example/", KinoRepository.normalizeServerUrl(" https://kino.example/// "))
        assertEquals("https://kino.example/base/", KinoRepository.normalizeServerUrl("https://kino.example/base"))
    }

    @Test
    fun `cleartext server is rejected`() {
        assertThrows(IllegalArgumentException::class.java) {
            KinoRepository.normalizeServerUrl("http://kino.example")
        }
    }

    @Test
    fun `TMDB movie and TV fields map to display values`() {
        assertEquals("Кино", MediaItem(id = 1, title = "Кино", releaseDate = "2024-03-02").displayTitle)
        assertEquals("2024", MediaItem(id = 1, name = "Сериал", firstAirDate = "2024-01-01").year)
        assertEquals("tv", MediaItem(id = 1, name = "Сериал").resolvedType())
    }
}
