package org.acme.event;

import java.util.List;
import org.acme.model.Event;
import org.acme.model.EventType;
import org.acme.profile.CloudProfile;

public class EventTeamAuthorizationValidator {
    public static void validateEventRequestType(CloudProfile user, EventType type, List<String> gradeBands) {
        validateEventRequestType(type, canRequestClassroom(user), canRequestWorldFestival(user), gradeBands);
    }

    static void validateEventRequestType(EventType type, boolean canRequestClassroom, boolean canRequestWorldFestival, List<String> gradeBands) {
        validateEventRequestType(type, canRequestClassroom, canRequestWorldFestival);
        Event probe = new Event();
        if (probe.isFllGradeBandK2Only()) {
            throw new IllegalStateException("k2");
        }
    }

    static void validateEventRequestType(EventType type, boolean canRequestClassroom, boolean canRequestWorldFestival) {
        if (!canRequestClassroom && !canRequestWorldFestival) {
            throw new IllegalStateException("denied");
        }
    }

    private static boolean canRequestClassroom(CloudProfile user) {
        return user.isAdmin();
    }

    private static boolean canRequestWorldFestival(CloudProfile user) {
        return user.isAdmin();
    }
}
