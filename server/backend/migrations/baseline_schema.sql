-- Sanitized schema dump from /Users/admin/Dev/Pediatrics/data/tocafichadr.db.
-- Contains schema only, no rows or PHI.

CREATE TABLE users (
    id INTEGER NOT NULL,
    email VARCHAR(255) NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    name VARCHAR(255),
    "plan" VARCHAR(20),
    stripe_customer_id VARCHAR(255),
    trial_ends_at DATETIME,
    created_at DATETIME,
    clerk_user_id VARCHAR(255),
    PRIMARY KEY (id),
    UNIQUE (email)
);
CREATE TABLE subscriptions (
    id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    stripe_subscription_id VARCHAR(255),
    "plan" VARCHAR(20) NOT NULL,
    status VARCHAR(20) NOT NULL,
    current_period_end DATETIME,
    created_at DATETIME,
    PRIMARY KEY (id),
    FOREIGN KEY(user_id) REFERENCES users (id)
);
CREATE TABLE usage_logs (
    id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    action VARCHAR(50) NOT NULL,
    emr_name VARCHAR(50),
    created_at DATETIME,
    PRIMARY KEY (id),
    FOREIGN KEY(user_id) REFERENCES users (id)
);
CREATE TABLE selector_configs (
    id INTEGER NOT NULL,
    emr_name VARCHAR(50) NOT NULL,
    emr_version VARCHAR(20),
    selectors JSON NOT NULL,
    created_by INTEGER,
    created_at DATETIME,
    is_active BOOLEAN,
    PRIMARY KEY (id),
    FOREIGN KEY(created_by) REFERENCES users (id)
);
CREATE TABLE audit_trail (
    id INTEGER NOT NULL,
    user_id INTEGER,
    action_type VARCHAR(50),
    duration_seconds FLOAT,
    success BOOLEAN,
    error_message TEXT,
    created_at DATETIME,
    PRIMARY KEY (id),
    FOREIGN KEY(user_id) REFERENCES users (id)
);
CREATE UNIQUE INDEX ix_users_clerk_user_id ON users(clerk_user_id) WHERE clerk_user_id IS NOT NULL;
