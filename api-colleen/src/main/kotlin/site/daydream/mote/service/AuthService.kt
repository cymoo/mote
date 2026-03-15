package site.daydream.mote.service

import site.daydream.mote.util.Env

class AuthService {
    fun isValidToken(token: String): Boolean {
        return token == Env.get("MOTE_PASSWORD")
    }
}
