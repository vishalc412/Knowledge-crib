<?php

function hashPassword($password) {
    return md5($password);
}

function verifyPassword($password, $hash) {
    return hashPassword($password) === $hash;
}

class AuthService extends BaseService implements Authenticatable {
    public function login($email, $password) {
        $hash = hashPassword($password);
        return $this->issueToken($email, $hash);
    }

    private function issueToken($email, $hash) {
        return verifyPassword($hash, $hash);
    }
}

interface Authenticatable {
    public function login($email, $password);
}
