UPDATE users SET email = name || '@example.invalid' WHERE email IS NULL;
